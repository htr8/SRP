export const InputHealthState = Object.freeze({
    unknown: 0,
    noSignal: 1,
    quiet: 2,
    usableButQuiet: 3,
    healthy: 4,
    hot: 5,
    clipping: 6,
    unavailable: 7,
});

export const InputHealthStateName = Object.freeze({
    [InputHealthState.unknown]: 'Unknown',
    [InputHealthState.noSignal]: 'NoSignal',
    [InputHealthState.quiet]: 'Quiet',
    [InputHealthState.usableButQuiet]: 'UsableButQuiet',
    [InputHealthState.healthy]: 'Healthy',
    [InputHealthState.hot]: 'Hot',
    [InputHealthState.clipping]: 'Clipping',
    [InputHealthState.unavailable]: 'Unavailable',
});

export const InputHealthAction = Object.freeze({
    healthy: 'Level looks healthy.',
    clipping: 'Input is clipping. Lower the TD-27, interface, pedal, mic preamp, or phone input level.',
    quiet: 'Input is very quiet. Raise the source or input level before recording.',
    usableButQuiet: 'Input is usable but quiet. Consider raising the source or input level.',
    hot: 'Input is strong and close to clipping. Leave headroom or lower the source slightly.',
    unavailable: 'Input monitoring is unavailable for this device or host.',
});

export function ampToDb(value) {
    return value > 0 ? 20 * Math.log10(value) : -120;
}

export function classifyInputHealth({ peakDb, rmsDb, clippedSampleCount = 0 } = {}) {
    if (!Number.isFinite(peakDb) || !Number.isFinite(rmsDb)) {
        return InputHealthState.noSignal;
    }
    if (clippedSampleCount > 0 || peakDb >= -0.2) {
        return InputHealthState.clipping;
    }
    if (isNearSilent(peakDb, rmsDb)) {
        return InputHealthState.quiet;
    }
    if (peakDb < -18) {
        return InputHealthState.usableButQuiet;
    }
    if (peakDb > -3) {
        return InputHealthState.hot;
    }
    return InputHealthState.healthy;
}

export function recommendationForState(state) {
    switch (state) {
        case InputHealthState.clipping:
            return InputHealthAction.clipping;
        case InputHealthState.quiet:
            return InputHealthAction.quiet;
        case InputHealthState.usableButQuiet:
            return InputHealthAction.usableButQuiet;
        case InputHealthState.hot:
            return InputHealthAction.hot;
        case InputHealthState.healthy:
            return InputHealthAction.healthy;
        case InputHealthState.noSignal:
            return InputHealthAction.quiet;
        case InputHealthState.unavailable:
            return InputHealthAction.unavailable;
        default:
            return '';
    }
}

export function buildInputHealth({ peakDb, rmsDb, clippedSampleCount = 0, channels = [] } = {}) {
    const state = classifyInputHealth({ peakDb, rmsDb, clippedSampleCount });
    return {
        state,
        peakDb,
        rmsDb,
        clippedSampleCount,
        nearSilent: isNearSilent(peakDb, rmsDb),
        recommendedAction: recommendationForState(state),
        channels,
    };
}

export function updateChannelAccumulators(accumulators, channelStats) {
    if (!channelStats || !channelStats.length) return;
    for (let i = 0; i < channelStats.length; i++) {
        const stat = channelStats[i];
        if (!stat) continue;
        const current = accumulators[i] || { channel: i + 1, peak: 0, sumSquares: 0, samples: 0, clipped: 0 };
        current.peak = Math.max(current.peak, stat.peak || 0);
        current.sumSquares += stat.sumSquares || 0;
        current.samples += stat.samples || 0;
        current.clipped += stat.clipped || 0;
        accumulators[i] = current;
    }
}

export function resetWindowedAccumulators(accumulators) {
    for (const ch of accumulators) {
        if (ch) {
            ch.sumSquares = 0;
            ch.samples = 0;
        }
    }
}

export function buildHealthFromAccumulators(accumulators) {
    const channels = accumulators
        .filter(ch => ch && ch.samples > 0)
        .map(ch => {
            const rms = Math.sqrt(ch.sumSquares / ch.samples);
            return {
                channel: ch.channel,
                peakDb: ampToDb(ch.peak),
                rmsDb: ampToDb(rms),
                clippedSampleCount: ch.clipped,
            };
        });
    if (channels.length === 0) return null;

    const peakDb = Math.max(...channels.map(ch => ch.peakDb));
    const totalSamples = accumulators.reduce((sum, ch) => sum + (ch ? ch.samples : 0), 0);
    const totalSquares = accumulators.reduce((sum, ch) => sum + (ch ? ch.sumSquares : 0), 0);
    const clippedSampleCount = accumulators.reduce((sum, ch) => sum + (ch ? ch.clipped : 0), 0);
    const rmsDb = ampToDb(Math.sqrt(totalSquares / Math.max(1, totalSamples)));

    return buildInputHealth({ peakDb, rmsDb, clippedSampleCount, channels });
}

export function monoStats(samples) {
    if (!samples || samples.length === 0) {
        return null;
    }

    let sumSquares = 0;
    let peak = 0;
    let clipped = 0;
    for (let i = 0; i < samples.length; i++) {
        const value = samples[i];
        const abs = Math.abs(value);
        sumSquares += value * value;
        if (abs > peak) peak = abs;
        if (abs >= 0.999) clipped++;
    }

    return { channel: 1, peak, sumSquares, samples: samples.length, clipped };
}

export function scaledMeterLevel(rms) {
    return Math.min(1, Math.pow(rms * 2.2, 0.6));
}

function isNearSilent(peakDb, rmsDb) {
    return rmsDb < -55 || peakDb < -45;
}
