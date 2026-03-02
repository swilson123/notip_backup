// Helper to send a JSON command to the Waveshare board and await a matching JSON response
// Usage:
// const client = require('./waveshare_client');
// await client.sendCommandExpect(rover, {T:10032, id:1}, obj => obj.T === 20011, 3000)

module.exports = {
    sendCommandExpect: function (rover, message, matchFn, timeoutMs = 2000) {
        return new Promise((resolve, reject) => {
            if (!rover || !rover.waveshare || !rover.waveshare.parser || !rover.waveshare.serial) {
                return reject(new Error('Waveshare not connected or parser not initialized'));
            }

            let timer = null;

            // JSON line listener (existing Readline parser)
            const onData = function (input) {
                const line = input && input.toString ? input.toString().trim() : input;
                if (!line) return;
                let obj;
                try {
                    obj = JSON.parse(line);
                } catch (e) {
                    // not JSON — ignore
                    return;
                }

                try {
                    if (matchFn(obj)) {
                        clearTimeout(timer);
                        rover.waveshare.parser.removeListener('data', onData);
                        if (rover.waveshare.emitter && onFeedback) rover.waveshare.emitter.removeListener('feedback', onFeedback);
                        resolve(obj);
                    }
                } catch (err) {
                    // match function threw — ignore
                }
            };

            // binary parsed feedback listener (emitted by connect_to_waveshare)
            const onFeedback = function (obj) {
                try {
                    if (matchFn(obj)) {
                        clearTimeout(timer);
                        rover.waveshare.parser.removeListener('data', onData);
                        rover.waveshare.emitter.removeListener('feedback', onFeedback);
                        resolve(obj);
                    }
                } catch (err) {
                    // ignore
                }
            };

            // If a matching frame is already in the recent frames buffer, return it immediately
            if (rover.waveshare._lastFrames && Array.isArray(rover.waveshare._lastFrames)) {
                try {
                    const found = rover.waveshare._lastFrames.find(f => {
                        try { return matchFn(f); } catch (e) { return false; }
                    });
                    if (found) return resolve(found);
                } catch (e) {
                    // ignore
                }
            }

            rover.waveshare.parser.on('data', onData);
            if (rover.waveshare.emitter && typeof rover.waveshare.emitter.on === 'function') {
                rover.waveshare.emitter.on('feedback', onFeedback);
            }

            timer = setTimeout(() => {
                rover.waveshare.parser.removeListener('data', onData);
                if (rover.waveshare.emitter && typeof rover.waveshare.emitter.removeListener === 'function') rover.waveshare.emitter.removeListener('feedback', onFeedback);
                reject(new Error('Timeout waiting for response'));
            }, timeoutMs);

            // send message
            try {
                const line = JSON.stringify(message) + '\n';
                rover.waveshare.serial.write(line, (err) => {
                    if (err) {
                        clearTimeout(timer);
                        rover.waveshare.parser.removeListener('data', onData);
                        if (rover.waveshare.emitter && typeof rover.waveshare.emitter.removeListener === 'function') rover.waveshare.emitter.removeListener('feedback', onFeedback);
                        reject(err);
                    }
                });
            } catch (err) {
                clearTimeout(timer);
                rover.waveshare.parser.removeListener('data', onData);
                if (rover.waveshare.emitter && typeof rover.waveshare.emitter.removeListener === 'function') rover.waveshare.emitter.removeListener('feedback', onFeedback);
                reject(err);
            }
        });
    }
};
