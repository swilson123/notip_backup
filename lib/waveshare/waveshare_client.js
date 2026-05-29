// Helper to send a JSON command to the Waveshare board and await a matching JSON response
// Usage:
// const client = require('./waveshare_client');
// await client.sendCommandExpect(white_rabbit, {T:10032, id:1}, obj => obj.T === 20011, 3000)

module.exports = {
    sendCommandExpect: function (white_rabbit, message, matchFn, timeoutMs = 2000) {
        return new Promise((resolve, reject) => {
            if (!white_rabbit || !white_rabbit.waveshare || !white_rabbit.waveshare.parser || !white_rabbit.waveshare.serial) {
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
                        white_rabbit.waveshare.parser.removeListener('data', onData);
                        if (white_rabbit.waveshare.emitter && onFeedback) white_rabbit.waveshare.emitter.removeListener('feedback', onFeedback);
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
                        white_rabbit.waveshare.parser.removeListener('data', onData);
                        white_rabbit.waveshare.emitter.removeListener('feedback', onFeedback);
                        resolve(obj);
                    }
                } catch (err) {
                    // ignore
                }
            };

            // If a matching frame is already in the recent frames buffer, return it immediately
            if (white_rabbit.waveshare._lastFrames && Array.isArray(white_rabbit.waveshare._lastFrames)) {
                try {
                    const found = white_rabbit.waveshare._lastFrames.find(f => {
                        try { return matchFn(f); } catch (e) { return false; }
                    });
                    if (found) return resolve(found);
                } catch (e) {
                    // ignore
                }
            }

            white_rabbit.waveshare.parser.on('data', onData);
            if (white_rabbit.waveshare.emitter && typeof white_rabbit.waveshare.emitter.on === 'function') {
                white_rabbit.waveshare.emitter.on('feedback', onFeedback);
            }

            timer = setTimeout(() => {
                white_rabbit.waveshare.parser.removeListener('data', onData);
                if (white_rabbit.waveshare.emitter && typeof white_rabbit.waveshare.emitter.removeListener === 'function') white_rabbit.waveshare.emitter.removeListener('feedback', onFeedback);
                reject(new Error('Timeout waiting for response'));
            }, timeoutMs);

            // send message
            try {
                const line = JSON.stringify(message) + '\n';
                white_rabbit.waveshare.serial.write(line, (err) => {
                    if (err) {
                        clearTimeout(timer);
                        white_rabbit.waveshare.parser.removeListener('data', onData);
                        if (white_rabbit.waveshare.emitter && typeof white_rabbit.waveshare.emitter.removeListener === 'function') white_rabbit.waveshare.emitter.removeListener('feedback', onFeedback);
                        reject(err);
                    }
                });
            } catch (err) {
                clearTimeout(timer);
                white_rabbit.waveshare.parser.removeListener('data', onData);
                if (white_rabbit.waveshare.emitter && typeof white_rabbit.waveshare.emitter.removeListener === 'function') white_rabbit.waveshare.emitter.removeListener('feedback', onFeedback);
                reject(err);
            }
        });
    }
};
