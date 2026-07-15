function audioConstraints(deviceId) {
    return {
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
    };
}

async function listAudioInputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return [];
    }

    let devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.some(d => d.kind === 'audioinput' && !d.label)) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            for (const track of stream.getTracks()) track.stop();
            devices = await navigator.mediaDevices.enumerateDevices();
        } catch {
            // Permission denied or unavailable: keep the partial device list.
        }
    }

    return devices
        .filter(d => d.kind === 'audioinput')
        .map((d, index) => ({ id: d.deviceId, label: d.label || `Audio input ${index + 1}` }));
}

async function tryOpenAudio(deviceId, audioInputs) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return { success: false, deviceId, label: null, channelCount: null, sampleRate: null, error: 'getUserMedia is unavailable.' };
    }

    let stream = null;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId) });
        const track = stream.getAudioTracks()[0];
        const settings = track ? track.getSettings() : {};
        const actualDeviceId = settings.deviceId || deviceId || null;
        const input = audioInputs.find(i => i.id === actualDeviceId) || audioInputs.find(i => i.id === deviceId);
        return {
            success: true,
            deviceId: actualDeviceId,
            label: input ? input.label : (track ? track.label : null),
            channelCount: typeof settings.channelCount === 'number' ? settings.channelCount : null,
            sampleRate: typeof settings.sampleRate === 'number' ? settings.sampleRate : null,
            error: null,
        };
    } catch (err) {
        return {
            success: false,
            deviceId: deviceId || null,
            label: null,
            channelCount: null,
            sampleRate: null,
            error: err && err.message ? err.message : String(err),
        };
    } finally {
        if (stream) {
            for (const track of stream.getTracks()) track.stop();
        }
    }
}

async function listMidiInputs() {
    if (!navigator.requestMIDIAccess) {
        return [];
    }

    const access = await navigator.requestMIDIAccess({ sysex: false });
    return Array.from(access.inputs.values()).map(input => ({
        id: input.id || '',
        name: input.name || '',
        manufacturer: input.manufacturer || '',
        state: input.state || '',
        connection: input.connection || '',
    }));
}

function caps() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    let outputTimestamp = false;
    if (AudioContextCtor) {
        try {
            outputTimestamp = typeof AudioContextCtor.prototype.getOutputTimestamp === 'function';
        } catch {
            outputTimestamp = false;
        }
    }

    return {
        mediaDevices: !!navigator.mediaDevices,
        getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        enumerateDevices: !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices),
        requestMidiAccess: !!navigator.requestMIDIAccess,
        audioContext: !!AudioContextCtor,
        audioContextOutputTimestamp: outputTimestamp,
        userAgent: navigator.userAgent || '',
        platform: navigator.platform || '',
    };
}

function td27Match(text) {
    return /td[-\s]?27|roland/i.test(text || '');
}

export async function probe(audioInputDeviceId) {
    const capabilities = caps();
    const audioInputs = await listAudioInputs();
    const audioOpen = await tryOpenAudio(audioInputDeviceId, audioInputs);
    let midiInputs = [];
    let error = null;

    try {
        midiInputs = await listMidiInputs();
    } catch (err) {
        error = err && err.message ? err.message : String(err);
    }

    const td27AudioLikelyPresent = audioInputs.some(input => td27Match(input.label)) || td27Match(audioOpen.label);
    const td27MidiLikelyPresent = midiInputs.some(input => td27Match(`${input.manufacturer} ${input.name}`));

    return {
        capabilities,
        audioInputs,
        midiInputs,
        audioOpen,
        td27AudioLikelyPresent,
        td27MidiLikelyPresent,
        td27CompositeLikely: td27AudioLikelyPresent && td27MidiLikelyPresent,
        error,
    };
}
