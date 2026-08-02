// Contract stub for the scoped capture-lease coordinator. Capture services must reach this state
// through ICaptureLeaseCoordinator rather than importing this module independently.
let currentOwner = null;

const owners = new Set([
    "AudioRecording",
    "Monitoring",
    "Tuner",
    "InstrumentCapture",
    "VideoRecording"
]);

function requireOwner(owner) {
    if (!owners.has(owner)) {
        throw new Error(`Capture lease acquire/release failed: unknown owner '${owner}'.`);
    }
}

export function acquire(owner) {
    requireOwner(owner);

    // JavaScript run-to-completion keeps this compare-and-set atomic.
    if (currentOwner === null || currentOwner === owner) {
        currentOwner = owner;
        return {
            acquired: true,
            requestingOwner: owner,
            conflictOwner: null,
            conflictReason: null
        };
    }

    return {
        acquired: false,
        requestingOwner: owner,
        conflictOwner: currentOwner,
        conflictReason: `Stop ${currentOwner} before starting ${owner}.`
    };
}

export function release(owner) {
    requireOwner(owner);

    if (currentOwner === null) {
        return {
            status: "AlreadyReleased",
            requestingOwner: owner,
            currentOwner: null
        };
    }

    if (currentOwner !== owner) {
        return {
            status: "NotOwner",
            requestingOwner: owner,
            currentOwner
        };
    }

    currentOwner = null;
    return {
        status: "Released",
        requestingOwner: owner,
        currentOwner: null
    };
}
