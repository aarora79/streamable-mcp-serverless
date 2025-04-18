import log4js from 'log4js';
import { unlinkSync } from 'fs';

const LOG_FILE = './server.log';

// try { unlinkSync(LOG_FILE); } catch (e) { };

const layout = {
    type: 'pattern',
    // pattern: '%[%d{hh:mm:ss.SSS} %p [%f{1}:%l:%M] %m%]'
    pattern: '%[%p [%f{1}:%l:%M] %m%]'
}

log4js.configure({
    appenders: {
        stdout: {
            type: 'stdout',
            enableCallStack: true,
            layout
        },
        file: {
            type: 'file',
            filename: LOG_FILE,
            enableCallStack: true,
            layout
        }
    },
    categories: {
        default: {
            appenders: ['stdout'],
            // appenders: ['file'],
            level: 'debug',
            enableCallStack: true
        }
    }
});
