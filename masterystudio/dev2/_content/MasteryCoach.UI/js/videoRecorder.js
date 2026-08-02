// The caller side of the video recording sink (VideoLibraryAndStudioSourcePlan.md §6.3,
// phase3-video-008 storage primitives plus phase1-video-045 capture. The C# side coordinates the
// host-specific session bridge; capture-lease ownership remains in VideoRecordingLifecycleService.
//
// SCOPE — this module owns capture plus the browser recording-storage client: it feeds recorder chunks
// into videoWorker.js's OPFS sink under a bounded queue, finalizes/cancels/sweeps, and implements
// getUserMedia, MediaRecorder negotiation, permissions, and preview (ARCH-018). Capture-lease,
// wake-lock, sink-completion, and domain-persistence ownership remain deliberately absent; the
// VideoRecordingLifecycleService owns that transaction.
// That separation is what makes the sink's failure
// modes testable independently: synthetic chunks still exercise NaN-duration and backpressure
// paths never run in CI. The suite drives everything below with synthetic chunk streams.
//
// THE TWO RULES THE SHAPE ENFORCES:
//
//   1. §6.3 / locked decision §2.14: "holding the whole recording as a Blob list, byte[], or
//      ArrayBuffer until Stop is forbidden". BoundedChunkPump is the guard — at most `maxPending`
//      chunks may be resident awaiting storage, and the (maxPending + 1)th enqueue REJECTS with
//      "storage is too slow" rather than queueing. It never drops a chunk and reports success; a
//      refused chunk poisons the pump, and the sink refuses to finalize as if whole.
//   2. Bytes never cross into .NET/WASM memory beyond metadata (§6.3's WASM/iOS host rule). Chunks go
//      Blob -> ArrayBuffer -> worker, entirely on this side. Shared .NET sees an opaque token and
//      scalar metadata; the host store alone retains the path.
//
// The pump's shape is the one the P0 spike proved on device
// (prototypes/VideoRecordingFinalizationSpike/web/recording-core.mjs): the accepted iPhone run wrote
// 694 chunks / 482,547,724 bytes with a peak pending queue of 1, i.e. the bound is a safety ceiling
// nothing on a healthy device ever reaches — which is exactly why it needs a test.
//
// Node-import safe (module-imports smoke test): no browser globals touched at module scope.

import {
    openOpfsVideoUrl,
    probeVideoPlayable,
    recordingWorkerOp,
    revokeVideoUrl,
} from './videoStore.js';

/// §6.3's default bound: "At most a small bounded queue (for example 3 chunks) may await storage."
export const DEFAULT_MAX_PENDING = 3;

export const STANDARD_CAPTURE_MIME_CANDIDATES = Object.freeze([
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
]);

export const SAFARI_OPFS_CAPTURE_MIME_CANDIDATES = Object.freeze([
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
]);

export function isSafariOpfsHost() {
    const navigatorValue = globalThis.navigator;
    const agent = navigatorValue?.userAgent ?? '';
    const safari = /Safari\//.test(agent) && !/(Chrome|Chromium|CriOS|Edg|OPR)\//.test(agent);
    return safari && !!navigatorValue?.storage?.getDirectory;
}

/// Select only a type that both MediaRecorder and the local video element explicitly support. Safari
/// on OPFS is WebM-first and fail-closed because the rejected P0 MP4 capture finalized with a
/// 7,158,897-second duration. A type that can be recorded but cannot be locally decoded would only
/// survive until the coordinator's final probe, where it must be discarded without creating a row.
export function negotiateCaptureMimeType({
    mediaRecorder = globalThis.MediaRecorder,
    safariOpfs = isSafariOpfsHost(),
    canPlayType = captureCanPlayType,
} = {}) {
    if (!mediaRecorder || typeof mediaRecorder.isTypeSupported !== 'function') {
        return {
            supported: false,
            mimeType: null,
            candidates: [],
            actionableMessage:
                'Video recording is unavailable because this browser does not provide MediaRecorder.',
        };
    }

    const candidates = safariOpfs
        ? SAFARI_OPFS_CAPTURE_MIME_CANDIDATES
        : STANDARD_CAPTURE_MIME_CANDIDATES;
    const mimeType = candidates.find(candidate =>
        mediaRecorder.isTypeSupported(candidate) && canPlayType(candidate)) ?? null;
    return {
        supported: mimeType !== null,
        mimeType,
        candidates: [...candidates],
        actionableMessage: mimeType
            ? null
            : safariOpfs
                ? 'Video recording is unavailable because Safari did not offer the required WebM ' +
                  'recorder and locally playable output. MP4 is disabled here because it did not ' +
                  'finalize safely.'
                : 'Video recording is unavailable because no locally playable MP4 or WebM recorder ' +
                  'was found.',
    };
}

function captureCanPlayType(mimeType) {
    const video = globalThis.document?.createElement?.('video');
    return typeof video?.canPlayType === 'function' && video.canPlayType(mimeType) !== '';
}

let capturePreviewElement = null;
let capturePreviewOptions = {
    cameraId: null,
    facingMode: 'environment',
    includeAudio: true,
    width: 1280,
    height: 720,
};
let captureStream = null;
let captureRecorder = null;
let captureSessionToken = null;
let captureDotNet = null;
let captureNativeDelivery = false;
let captureStartedAt = 0;
let captureActualMimeType = null;
let captureBytesDelivered = 0;
let captureCancelling = false;
let captureFailure = null;
let captureDeliveries = new Set();
let captureNativeChunks = [];
let captureNativeDeliveryActive = false;
let captureStopCompletion = null;
let completeCaptureStop = null;
let captureTerminalNotified = false;
let captureTerminalListeners = [];

export async function getCaptureCapabilities() {
    const secureContext = globalThis.isSecureContext === true;
    const mediaDevices = globalThis.navigator?.mediaDevices;
    const negotiated = negotiateCaptureMimeType();
    if (!secureContext || !mediaDevices?.getUserMedia || !mediaDevices?.enumerateDevices) {
        return {
            supported: false,
            secureContext,
            permissionDenied: false,
            actionableMessage: !secureContext
                ? 'Camera recording requires a secure HTTPS context.'
                : 'Camera recording is unavailable because this browser has no media-device API.',
            cameras: [],
            microphones: [],
            supportedMimeTypes: [],
        };
    }

    const devices = await mediaDevices.enumerateDevices();
    let availableStorageBytes = null;
    let quotaHealthy = false;
    if (globalThis.navigator?.storage?.estimate) {
        try {
            const estimate = await globalThis.navigator.storage.estimate();
            if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage)) {
                availableStorageBytes = Math.max(0, estimate.quota - estimate.usage);
                // 1080p is deliberately conservative: offer it only with at least 2 GiB currently
                // available. Unknown quota is not "healthy" and therefore keeps the 720p default.
                quotaHealthy = availableStorageBytes >= 2 * 1024 * 1024 * 1024;
            }
        } catch {
            // Storage estimates are optional and privacy-sensitive. An unavailable estimate keeps
            // 1080p disabled; it must never disable ordinary 720p recording.
        }
    }
    const mapDevice = device => ({
        deviceId: device.deviceId ?? '',
        label: device.label || (device.kind === 'videoinput' ? 'Camera' : 'Microphone'),
        kind: device.kind,
    });
    return {
        supported: negotiated.supported,
        secureContext,
        permissionDenied: false,
        actionableMessage: negotiated.actionableMessage,
        cameras: devices.filter(device => device.kind === 'videoinput').map(mapDevice),
        microphones: devices.filter(device => device.kind === 'audioinput').map(mapDevice),
        supportedMimeTypes: negotiated.candidates.filter(candidate =>
            globalThis.MediaRecorder.isTypeSupported(candidate) && captureCanPlayType(candidate)),
        quotaHealthy,
        availableStorageBytes,
    };
}

export function attachCapturePreview(element) {
    capturePreviewElement = element ?? null;
    applyPreviewElement();
}

export function configureCapturePreview(options = {}) {
    if (captureRecorder?.state === 'recording') {
        throw new Error('configureCapturePreview: camera settings cannot change while recording.');
    }
    capturePreviewOptions = { ...capturePreviewOptions, ...options };
}

function previewConstraints() {
    const camera = capturePreviewOptions.cameraId
        ? { deviceId: { exact: capturePreviewOptions.cameraId } }
        : { facingMode: { ideal: capturePreviewOptions.facingMode || 'environment' } };
    return {
        video: {
            ...camera,
            width: { ideal: capturePreviewOptions.width || 1280 },
            height: { ideal: capturePreviewOptions.height || 720 },
        },
        audio: capturePreviewOptions.includeAudio !== false,
    };
}

function stopStreamTracks(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    for (const track of stream.getTracks()) track.stop();
}

function previewState(stream, actionableMessage = null) {
    const videoTrack = stream?.getVideoTracks?.()[0] ?? null;
    const settings = videoTrack?.getSettings?.() ?? {};
    const capabilities = videoTrack?.getCapabilities?.() ?? {};
    const facingMode = settings.facingMode ?? capturePreviewOptions.facingMode ?? null;
    return {
        ready: !!videoTrack,
        mirrored: facingMode === 'user',
        cameraId: settings.deviceId ?? capturePreviewOptions.cameraId ?? null,
        facingMode,
        actionableMessage,
        maximumWidth: Number.isFinite(capabilities.width?.max) ? capabilities.width.max : null,
        maximumHeight: Number.isFinite(capabilities.height?.max) ? capabilities.height.max : null,
    };
}

function applyPreviewElement() {
    if (!capturePreviewElement) return;
    capturePreviewElement.muted = true;
    capturePreviewElement.autoplay = true;
    capturePreviewElement.playsInline = true;
    capturePreviewElement.srcObject = captureStream;
    capturePreviewElement.style.transform =
        previewState(captureStream).mirrored ? 'scaleX(-1)' : '';
}

export async function startCapturePreview() {
    if (captureStream?.active) {
        applyPreviewElement();
        return previewState(captureStream);
    }

    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (!globalThis.isSecureContext || !mediaDevices?.getUserMedia) {
        return previewState(null,
            !globalThis.isSecureContext
                ? 'Camera permission requires HTTPS. Open this page from a secure address.'
                : 'This browser does not provide camera and microphone capture.');
    }

    try {
        // Capability discovery never opens a device. This first getUserMedia call is reached directly
        // from the capture-start tap through VideoRecordingLifecycleService.OpenAsync.
        captureStream = await mediaDevices.getUserMedia(previewConstraints());
        applyPreviewElement();
        return previewState(captureStream);
    } catch (error) {
        stopStreamTracks(captureStream);
        captureStream = null;
        const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
        return previewState(null, denied
            ? 'Camera or microphone permission was denied. Enable it in browser/device settings and retry.'
            : `Camera preview could not start: ${error?.message || String(error)}`);
    }
}

export async function switchCapturePreviewCamera(cameraId, facingMode) {
    if (captureRecorder?.state === 'recording') {
        throw new Error('switchCapturePreviewCamera: camera switching is disabled while recording.');
    }

    // WebKit can retain both cameras if the old stream survives a failed second request.
    stopStreamTracks(captureStream);
    captureStream = null;
    capturePreviewOptions = {
        ...capturePreviewOptions,
        cameraId: cameraId || null,
        facingMode: facingMode || null,
    };
    applyPreviewElement();
    return await startCapturePreview();
}

export function describeCapturePreview() {
    return previewState(captureStream);
}

function rememberDelivery(promise) {
    captureDeliveries.add(promise);
    promise.then(
        () => captureDeliveries.delete(promise),
        () => captureDeliveries.delete(promise));
}

async function deliverCaptureChunk(blob) {
    if (!blob || blob.size === 0 || captureCancelling) return;
    if (!captureSessionToken || !captureDotNet) {
        throw new Error('Recorder chunk delivery failed: no active sink session callback exists.');
    }

    if (captureNativeDelivery) {
        await deliverNativeCaptureChunk(blob);
    } else {
        await appendRecordingChunk(captureSessionToken, blob);
        const partLength = blob.size;
        await captureDotNet.invokeMethodAsync(
            'ObserveAppendAsync', captureSessionToken, partLength);
    }
    captureBytesDelivered += blob.size;
}

async function deliverNativeCaptureChunk(blob) {
    // WebView2's blazor.webview.js cannot deserialize an IJSStreamReference passed as a
    // JS-to-.NET argument. Keep a bounded FIFO queue in JS and let .NET pull one Blob as the RETURN
    // value of takeNativeRecordingChunk instead. The returned stream is supported by BlazorWebView.
    if (captureNativeChunks.length >= DEFAULT_MAX_PENDING) {
        throw new Error(
            `Recording storage is too slow: ${captureNativeChunks.length} native chunks are already ` +
            `awaiting host storage (limit ${DEFAULT_MAX_PENDING}). Recording stopped without dropping a chunk.`);
    }

    return new Promise((resolve, reject) => {
        captureNativeChunks.push({ blob, resolve, reject });
        void drainNativeCaptureChunks();
    });
}

async function drainNativeCaptureChunks() {
    if (captureNativeDeliveryActive) return;

    captureNativeDeliveryActive = true;
    let active = null;
    try {
        while (captureNativeChunks.length > 0) {
            const next = active = captureNativeChunks[0];
            const expectedLength = next.blob.size;
            await captureDotNet.invokeMethodAsync(
                'PullNativeChunkAsync', captureSessionToken, expectedLength);
            // takeNativeRecordingChunk removes the head before returning it. If it did not, the host
            // callback would have succeeded without consuming the advertised chunk, which is unsafe.
            if (captureNativeChunks[0] === next) {
                throw new Error('Native recording chunk pull completed without consuming its queued Blob.');
            }
            next.resolve();
            active = null;
        }
    } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        active?.reject(failure);
        for (const pending of captureNativeChunks.splice(0)) pending.reject(failure);
    } finally {
        captureNativeDeliveryActive = false;
    }
}

/// .NET calls this while handling PullNativeChunkAsync. A Blob RETURN value becomes an
/// IJSStreamReference on the .NET-to-JS interop direction; it is never a JS-to-.NET argument.
export function takeNativeRecordingChunk(sessionToken) {
    if (sessionToken !== captureSessionToken) {
        throw new Error(
            `takeNativeRecordingChunk: token '${sessionToken || '<empty>'}' does not own the active recording sink.`);
    }
    const pending = captureNativeChunks.shift();
    if (!pending) {
        throw new Error(`takeNativeRecordingChunk: no queued native chunk exists for '${sessionToken}'.`);
    }
    return pending.blob;
}

export function prepareCaptureRecording(requestedMimeType, options = {}) {
    if (!captureStream?.active) {
        throw new Error('prepareCaptureRecording: start the permission-on-tap preview first.');
    }
    if (captureRecorder) {
        throw new Error('prepareCaptureRecording: another recorder is already prepared or active.');
    }
    const negotiated = negotiateCaptureMimeType();
    if (!requestedMimeType || requestedMimeType !== negotiated.mimeType) {
        throw new Error(
            `prepareCaptureRecording: requested MIME '${requestedMimeType || '<empty>'}' was not ` +
            'selected from the locally playable recorder candidates.');
    }
    if (isSafariOpfsHost() && !requestedMimeType.startsWith('video/webm')) {
        throw new Error('prepareCaptureRecording: Safari/OPFS requires WebM; MP4 is disabled.');
    }

    const recorderOptions = { mimeType: requestedMimeType };
    if (Number.isInteger(options.videoBitsPerSecond) && options.videoBitsPerSecond > 0) {
        recorderOptions.videoBitsPerSecond = options.videoBitsPerSecond;
    }
    if (Number.isInteger(options.audioBitsPerSecond) && options.audioBitsPerSecond > 0) {
        recorderOptions.audioBitsPerSecond = options.audioBitsPerSecond;
    }

    captureRecorder = new globalThis.MediaRecorder(captureStream, recorderOptions);
    captureActualMimeType = captureRecorder.mimeType;
    if (!captureActualMimeType) {
        captureRecorder = null;
        throw new Error('prepareCaptureRecording: MediaRecorder returned an empty actual MIME type.');
    }
    return {
        actualMimeType: captureActualMimeType,
        startedAtUnixMilliseconds: 0,
    };
}

export function startCaptureRecording(
    sessionToken,
    nativeStreamDelivery = false,
    dotNetReference) {
    if (!captureRecorder || captureRecorder.state !== 'inactive') {
        throw new Error('startCaptureRecording: prepare one inactive recorder first.');
    }
    if (!sessionToken || !dotNetReference) {
        throw new Error('startCaptureRecording: a sink token and callback are required.');
    }

    captureSessionToken = sessionToken;
    captureDotNet = dotNetReference;
    captureNativeDelivery = nativeStreamDelivery === true;
    captureStartedAt = Date.now();
    captureBytesDelivered = 0;
    captureCancelling = false;
    captureFailure = null;
    captureDeliveries = new Set();
    captureNativeChunks = [];
    captureNativeDeliveryActive = false;
    // MediaRecorder changes state to inactive synchronously when stop() is requested, before its
    // final dataavailable and stop events. Keep this promise from recorder creation until cleanup so
    // a terminal owner cannot mistake inactive for fully drained (ARCH-019).
    captureStopCompletion = new Promise(resolve => { completeCaptureStop = resolve; });
    captureTerminalNotified = false;
    addCaptureTerminalListeners();
    captureRecorder.addEventListener('dataavailable', event => {
        const delivery = deliverCaptureChunk(event.data).catch(error => {
            captureFailure ??= new Error(
                `Recorder chunk delivery failed: ${error?.message || String(error)}`);
            terminateCapture('chunk-delivery-failed');
        });
        rememberDelivery(delivery);
    });
    captureRecorder.addEventListener('error', event => {
        captureFailure ??= new Error(
            `MediaRecorder failed: ${event?.error?.message || event?.error?.name || 'unknown error'}`);
        terminateCapture('recorder-error');
    });
    captureRecorder.addEventListener('stop', () => completeCaptureStop?.(), { once: true });
    captureRecorder.start(1000);
}

function addCaptureTerminalListeners() {
    const add = (target, eventName, callback) => {
        if (!target?.addEventListener) return;
        target.addEventListener(eventName, callback);
        captureTerminalListeners.push(() => target.removeEventListener?.(eventName, callback));
    };

    add(globalThis, 'pagehide', () => terminateCapture('page-hidden'));
    add(globalThis.document, 'visibilitychange', () => {
        if (globalThis.document?.visibilityState === 'hidden') {
            terminateCapture('visibility-hidden');
        }
    });
    for (const track of captureStream?.getTracks?.() ?? []) {
        add(track, 'ended', () => terminateCapture('track-ended'));
    }
}

function removeCaptureTerminalListeners() {
    for (const remove of captureTerminalListeners) remove();
    captureTerminalListeners = [];
}

function terminateCapture(reason) {
    if (captureTerminalNotified || captureCancelling) return;
    captureTerminalNotified = true;
    removeCaptureTerminalListeners();
    const terminalCallback = captureDotNet?.invokeMethodAsync(
        'HandleRecordingTerminalEventAsync', reason);
    if (!terminalCallback) {
        console.error(`Recording terminal event '${reason}' could not reach .NET: no callback is active.`);
    } else {
        terminalCallback.catch(error => console.error(
            `Recording terminal event '${reason}' could not reach .NET: ${error?.message || String(error)}`, error));
    }
    // The lifecycle callback is the sole terminal owner. It installs the stop listener, requests
    // stop, drains the final chunk, then stops tracks and chooses finalize versus cancel. Stopping
    // here would flip state to inactive before that owner can observe MediaRecorder's queued final
    // dataavailable event, losing a healthy recording (ARCH-019).
}

function waitForRecorderStop(recorder) {
    if (!recorder) return Promise.resolve();
    const completion = captureStopCompletion;
    if (recorder.state === 'inactive') return completion ?? Promise.resolve();
    return new Promise((resolve, reject) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.addEventListener('error', event => reject(
            event?.error ?? new Error('MediaRecorder failed while stopping.')), { once: true });
        recorder.stop();
    }).then(() => completion ?? Promise.resolve());
}

function clearCaptureState() {
    removeCaptureTerminalListeners();
    if (capturePreviewElement) {
        capturePreviewElement.srcObject = null;
        capturePreviewElement.style.transform = '';
    }
    captureStream = null;
    captureRecorder = null;
    captureSessionToken = null;
    captureDotNet = null;
    captureNativeDelivery = false;
    captureActualMimeType = null;
    captureFailure = null;
    captureStopCompletion = null;
    completeCaptureStop = null;
    captureTerminalNotified = false;
    captureDeliveries.clear();
    captureNativeChunks = [];
    captureNativeDeliveryActive = false;
}

export async function stopCaptureRecording() {
    const recorder = captureRecorder;
    if (!recorder) throw new Error('stopCaptureRecording: no recording is active.');
    let stopFailure = null;
    try {
        await waitForRecorderStop(recorder);
    } catch (error) {
        stopFailure = new Error(
            `MediaRecorder failed while stopping: ${error?.message || String(error)}`);
    }
    const deliveryResults = await Promise.allSettled([...captureDeliveries]);
    const rejectedDelivery = deliveryResults.find(result => result.status === 'rejected');
    if (rejectedDelivery) {
        captureFailure ??= new Error(
            `Recorder chunk delivery failed: ${rejectedDelivery.reason?.message ||
            String(rejectedDelivery.reason)}`);
    }
    const settings = captureStream?.getVideoTracks?.()[0]?.getSettings?.() ?? {};
    const failure = captureFailure ?? stopFailure;
    const result = {
        actualMimeType: recorder.mimeType || captureActualMimeType,
        captureSeconds: Math.max(0, (Date.now() - captureStartedAt) / 1000),
        width: settings.width ?? null,
        height: settings.height ?? null,
        bytesDelivered: captureBytesDelivered,
    };
    stopStreamTracks(captureStream);
    clearCaptureState();
    if (failure) throw failure;
    return result;
}

export async function cancelCaptureRecording() {
    captureCancelling = true;
    let stopFailure = null;
    try {
        await waitForRecorderStop(captureRecorder);
    } catch (error) {
        stopFailure = error;
    }
    const deliveryResults = await Promise.allSettled([...captureDeliveries]);
    const failure = captureFailure ?? stopFailure ??
        deliveryResults.find(result => result.status === 'rejected')?.reason ??
        null;
    stopStreamTracks(captureStream);
    clearCaptureState();
    if (failure) {
        throw new Error(
            `Cancelling the video recorder found a failed chunk delivery: ` +
            `${failure?.message || String(failure)}`);
    }
}

export async function stopCaptureTracks() {
    await cancelCaptureRecording();
}

export async function disposeCaptureRecorder() {
    await cancelCaptureRecording();
    capturePreviewElement = null;
}

/// The bounded pending-chunk queue with a safe backpressure stop (§6.3).
///
/// Appends are serialized through `#tail` — the OPFS sink writes at a running offset, so two
/// overlapping appends would interleave bytes and corrupt both the container and the running hash.
/// `#pending` counts chunks that have been accepted but not yet stored; that count, not the queue
/// length, is what caps peak memory, because each pending chunk's buffer is resident until its append
/// resolves.
export class BoundedChunkPump {
    #append;
    #failure = null;
    #nextSequence = 0;
    #pending = 0;
    #tail = Promise.resolve();

    constructor({ append, maxPending = DEFAULT_MAX_PENDING } = {}) {
        if (typeof append !== 'function') {
            throw new Error('BoundedChunkPump requires an append(sequence, buffer) function.');
        }
        if (!Number.isInteger(maxPending) || maxPending < 1) {
            throw new Error(
                `BoundedChunkPump maxPending must be a positive integer, got '${maxPending}'.`);
        }
        this.#append = append;
        this.maxPending = maxPending;
        this.bytesWritten = 0;
        this.chunksWritten = 0;
        this.peakPending = 0;
    }

    get pending() { return this.#pending; }

    /// Whether the pump has stopped, and why. Non-null means every further enqueue is refused and the
    /// recording can no longer be finalized as whole.
    get failure() { return this.#failure; }

    /// Accept one recorder chunk. Returns a promise that settles when the chunk has been STORED —
    /// awaiting it is what applies backpressure to a caller that can pause its recorder.
    ///
    /// Rejects immediately, without queueing, once `maxPending` chunks are already pending. That is
    /// §6.3's "stops safely with 'storage is too slow' before the queue grows without bound": the
    /// alternative shapes are dropping the chunk (a truncated recording presented as valid) or
    /// queueing it (the whole recording resident in memory, which terminated the iPhone tab).
    enqueue(blob) {
        if (this.#failure) {
            return Promise.reject(this.#failure);
        }
        if (!blob || typeof blob.arrayBuffer !== 'function') {
            return Promise.reject(new Error('Recorder chunk does not expose arrayBuffer().'));
        }
        if (this.#pending >= this.maxPending) {
            const error = new Error(
                `Recording storage is too slow: ${this.#pending} chunks are already pending, which is ` +
                `the bound (${this.maxPending}). Recording stopped rather than dropping chunks or ` +
                'letting the pending queue grow without bound (plan §6.3).');
            this.#failure = error;
            return Promise.reject(error);
        }

        const sequence = this.#nextSequence++;
        this.#pending += 1;
        this.peakPending = Math.max(this.peakPending, this.#pending);

        const operation = this.#tail.then(async () => {
            const buffer = await blob.arrayBuffer();
            // The worker takes ownership of the buffer, detaching it here; read the length first.
            const byteLength = buffer.byteLength;
            await this.#append(sequence, buffer);
            this.bytesWritten += byteLength;
            this.chunksWritten += 1;
        });

        this.#tail = operation
            .catch((error) => {
                this.#failure ??= new Error(
                    `Appending recorder chunk ${sequence} failed, so this recording cannot be ` +
                    `completed: ${(error && error.message) || String(error)}`);
            })
            .finally(() => { this.#pending -= 1; });

        return operation;
    }

    /// Wait for every accepted chunk to be stored, then report what was written — or throw the reason
    /// the recording must not be finalized. Stop calls this before finalizing, which is what makes
    /// "never present a truncated file as valid" structural rather than a remembered check.
    async drain() {
        await this.#tail;
        if (this.#failure) {
            throw this.#failure;
        }
        return {
            bytesWritten: this.bytesWritten,
            chunksWritten: this.chunksWritten,
            peakPending: this.peakPending,
        };
    }
}

// -------------------------------------------------------------------------------------------------
// The sink lifecycle, as .NET calls it. Each function is a thin, named orchestration over the worker
// ops; the interesting behaviour (ordering, incremental hash, validation, the 24-hour sweep) lives in
// videoWorker.js, where the OPFS handle is.
// -------------------------------------------------------------------------------------------------

// Opaque session token -> { tempPath, mimeType, pump }. Only this host module resolves the token to
// OPFS; capture code cannot address the temp entry directly (ARCH-016).
const openSinks = new Map();

/// Open a temp OPFS entry for a new recording. `mimeType` is the container the recorder ACTUALLY
/// negotiated; .NET derives the final entry's extension from it, so nothing here hard-codes one.
///
/// Returns the opaque token after the worker confirms the temp exists. The legacy storage-test form
/// uses its private path as the key; production callers use a distinct token.
export async function beginRecording(
    sessionToken, tempPathOrMimeType, mimeTypeOrMaxPending, maxPending) {
    const bridged = arguments.length >= 4 || typeof mimeTypeOrMaxPending === 'string';
    const tempPath = bridged ? tempPathOrMimeType : sessionToken;
    const mimeType = bridged ? mimeTypeOrMaxPending : tempPathOrMimeType;
    const pendingLimit = bridged ? maxPending : mimeTypeOrMaxPending;
    // Awaited, so a worker-side failure to open the entry rejects HERE — before a pump exists. A pump
    // registered against a sink the worker never opened would accept chunks and lose every one.
    const started = await recordingWorkerOp({ op: 'recordBegin', tempPath, mimeType });
    if (!started || !started.tempPath) {
        throw new Error(
            `beginRecording: the worker did not report opening a recording entry for '${tempPath}', ` +
            'so there is no sink to append to. No recording was started.');
    }

    const pump = new BoundedChunkPump({
        append: (sequence, buffer) =>
            recordingWorkerOp({ op: 'recordAppend', tempPath, sequence, buffer }, [buffer]),
        maxPending: pendingLimit > 0 ? pendingLimit : DEFAULT_MAX_PENDING,
    });

    openSinks.set(sessionToken, { tempPath, mimeType, pump });
    return bridged ? sessionToken : started.tempPath;
}

/// Append one recorder chunk. Phase 6's capture code calls this from `dataavailable`; the suite calls
/// it with a synthetic Blob. Rejects — never silently drops — when the bound is reached.
export function appendRecordingChunk(sessionToken, blob) {
    const sink = openSinks.get(sessionToken);
    if (!sink) {
        return Promise.reject(new Error(
            `appendRecordingChunk: no open recording sink for token '${sessionToken}'. It was already finalized ` +
            'or cancelled, and a sink is resolved exactly once (plan §6.3).'));
    }
    return sink.pump.enqueue(blob);
}

export function observeRecordingChunkAppend(sessionToken, chunkLength) {
    const sink = openSinks.get(sessionToken);
    if (!sink) {
        throw new Error(
            `observeRecordingChunkAppend: no open recording sink for token '${sessionToken}'.`);
    }
    if (sink.pump.failure) {
        throw sink.pump.failure;
    }
    return {
        chunkLength,
        bytesWritten: sink.pump.bytesWritten,
        pending: sink.pump.pending,
        peakPending: sink.pump.peakPending,
    };
}

/// Drain the pump and report what the sink has actually stored, WITHOUT publishing anything.
///
/// This exists so the caller can apply §6.3's "if Stop yields no bytes ... do not create a record"
/// BEFORE asking for a commit. Splitting it out is what makes validate-then-publish an ordering the
/// caller enforces, rather than a rule it has to trust the finalize call to have applied internally.
///
/// Returns the running BYTE TOTAL the sink has stored. Throws — and cancels the sink — when a chunk
/// never reached storage, because a recording missing a chunk must never be finalized as if whole.
export async function recordedChunkTotalBytes(sessionToken) {
    const sink = openSinks.get(sessionToken);
    if (!sink) {
        throw new Error(
            `recordedChunkTotalBytes: no open recording sink for token '${sessionToken}'. It was already ` +
            'finalized or cancelled, and a sink is resolved exactly once (plan §6.3).');
    }

    try {
        return (await sink.pump.drain()).bytesWritten;
    } catch (err) {
        openSinks.delete(sessionToken);
        await recordingWorkerOp({ op: 'recordCancel', tempPath: sink.tempPath });
        throw new Error(
            `The recording cannot be finalized because a chunk did not reach storage: ` +
            `${(err && err.message) || 'storage failed'}. The temporary entry was deleted and no ` +
            'record was created (plan §6.3).');
    }
}

/// Drain the final chunk and ask a local video element to load metadata from the still-temporary
/// OPFS entry. The entry is not renamed here; a rejected probe remains safe to delete.
export async function probeRecordingPlayable(
    sessionToken, expectedDurationSeconds, timeoutMs = 10000) {
    const sink = openSinks.get(sessionToken);
    if (!sink) {
        throw new Error(
            `probeRecordingPlayable: no open recording sink for token '${sessionToken}'.`);
    }

    try {
        await sink.pump.drain();
    } catch (err) {
        openSinks.delete(sessionToken);
        await recordingWorkerOp({ op: 'recordCancel', tempPath: sink.tempPath });
        throw new Error(
            `probeRecordingPlayable refused the poisoned sink because a chunk did not reach storage: ` +
            `${(err && err.message) || 'storage failed'}. The temp was deleted.`);
    }

    await recordingWorkerOp({ op: 'recordPrepareProbe', tempPath: sink.tempPath });

    const opened = await openOpfsVideoUrl(sink.tempPath);
    if (!opened || !opened.url) {
        return {
            playable: false,
            reason: 'the finalized temporary recording could not be opened for playback',
            durationSeconds: null,
        };
    }

    try {
        const result = await probeVideoPlayable(opened.url, sink.mimeType, timeoutMs);
        const metadataObserved = result.metadataObserved === true;
        return {
            ...result,
            playable: result.playable && metadataObserved,
            reason: metadataObserved
                ? result.reason
                : result.reason || 'the local video element did not load finalized metadata',
            metadataObserved,
            durationSeconds: result.durationSeconds ?? null,
        };
    } finally {
        revokeVideoUrl(opened.url);
    }
}

/// Drain the pump, then finalize: the worker validates the finalized metadata and only then publishes
/// the temp entry to `finalPath`. Returns { bytesWritten, chunksWritten, hash }.
///
/// A drain failure is reported and the sink is CANCELLED rather than finalized — that is the "never
/// present a truncated file as valid" rule, applied where the caller can still see why.
export async function finishRecording(
    sessionToken, finalPath, durationSeconds, captureSeconds) {
    const sink = openSinks.get(sessionToken);
    if (!sink) {
        throw new Error(
            `finishRecording: no open recording sink for token '${sessionToken}'. It was already finalized or ` +
            'cancelled, and a sink is resolved exactly once (plan §6.3).');
    }

    try {
        await sink.pump.drain();
    } catch (err) {
        openSinks.delete(sessionToken);
        await recordingWorkerOp({ op: 'recordCancel', tempPath: sink.tempPath });
        throw new Error(
            `finishRecording refused to publish the recording because a chunk did not reach storage: ` +
            `${(err && err.message) || 'storage failed'}. The temporary entry was deleted and no ` +
            'record was created (plan §6.3).');
    }

    openSinks.delete(sessionToken);
    return await recordingWorkerOp({
        op: 'recordFinish', tempPath: sink.tempPath, finalPath, durationSeconds, captureSeconds,
    });
}

/// Abandon a recording: drop the pump and delete the temp entry. Idempotent — cancel, permission
/// denial, track loss, storage failure and page hide all reach it and overlap.
export async function cancelRecording(sessionToken) {
    const sink = openSinks.get(sessionToken);
    openSinks.delete(sessionToken);
    const result = await recordingWorkerOp({
        op: 'recordCancel',
        tempPath: sink ? sink.tempPath : sessionToken,
    });
    return !!(result && result.cancelled);
}

/// The §6.3 startup/next-open sweep. Returns how many abandoned temps were removed. Active sessions
/// are protected by the worker, which owns the register of open sinks — age alone must never condemn
/// a temp, because a long capture's entry looks old the whole time it is being written.
///
/// Named for what it sweeps (recording TEMPS) rather than for "abandoned": the sweep's scope is the
/// *.rec.tmp pattern, and a committed recording is never a candidate however old it is.
export async function cleanupRecordingTemps(root, olderThanMs) {
    const result = await recordingWorkerOp({ op: 'recordCleanup', root, olderThanMs });
    return (result && result.removed) || 0;
}
