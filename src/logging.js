import log4js from 'log4js';
import { unlinkSync } from 'fs';

// Check if we're running in Lambda
const isLambda = !!process.env.LAMBDA_TASK_ROOT;

// Set log file path based on environment
// In Lambda, use /tmp which is writable
const LOG_FILE = isLambda ? '/tmp/server.log' : './server.log';

// Try to clean up old log files if they exist
// try { unlinkSync(LOG_FILE); } catch (e) { };

// Define custom JSON layout for structured logging
const jsonLayout = {
    type: 'pattern',
    pattern: '%d{ISO8601_WITH_TZ_OFFSET} %p %c %m',
    // Transform log events to structured JSON format
    transform: (logEvent) => {
        const { startTime, categoryName, level, data } = logEvent;
        
        // Basic log structure
        const result = {
            timestamp: new Date(startTime).toISOString(),
            level: level.levelStr,
            category: categoryName,
        };
        
        // Handle different message formats
        if (data.length === 1) {
            // Simple string message
            if (typeof data[0] === 'string') {
                result.message = data[0];
            } 
            // Object that's already structured
            else if (typeof data[0] === 'object') {
                Object.assign(result, data[0]);
            }
        } else if (data.length > 1) {
            // Format with message and data
            result.message = data[0];
            result.data = data.slice(1);
        }
        
        // Include error stack if present
        if (logEvent.error) {
            result.error = {
                message: logEvent.error.message,
                name: logEvent.error.name,
                stack: logEvent.error.stack
            };
        }
        
        return JSON.stringify(result);
    }
};

// Define appenders based on environment
const appenders = {
    stdout: {
        type: 'stdout',
        enableCallStack: true,
        layout: {
            type: 'pattern',
            pattern: '%[%p [%f{1}:%l:%M] %m%]'
        }
    },
    stdoutJson: {
        type: 'stdout',
        layout: jsonLayout
    }
};

// Only add file appenders if not in Lambda
if (!isLambda) {
    appenders.file = {
        type: 'file',
        filename: LOG_FILE,
        enableCallStack: true,
        layout: {
            type: 'pattern',
            pattern: '%[%p [%f{1}:%l:%M] %m%]'
        }
    };
    appenders.fileJson = {
        type: 'file',
        filename: LOG_FILE + '.json',
        layout: jsonLayout
    };
}

// Configure log4js with appropriate appenders
log4js.configure({
    appenders: appenders,
    categories: {
        default: {
            appenders: isLambda ? ['stdout'] : ['stdout', 'fileJson'],
            level: 'debug',
            enableCallStack: true
        },
        auth: {
            appenders: isLambda ? ['stdout'] : ['stdout', 'fileJson'],
            level: 'debug',
            enableCallStack: true
        },
        api: {
            appenders: isLambda ? ['stdout'] : ['stdout', 'fileJson'],
            level: 'debug',
            enableCallStack: true
        }
    }
});

// Create logger instances for different components
export const logger = log4js.getLogger();
export const authLogger = log4js.getLogger('auth');
export const apiLogger = log4js.getLogger('api');

// Helper function to log HTTP requests in a structured way
export const logHttpRequest = (req, componentName = 'api') => {
    const logData = {
        type: 'request',
        method: req.method,
        path: req.path,
        headers: {
            // Include only relevant headers and redact sensitive information
            'content-type': req.headers['content-type'],
            'mcp-session-id': req.headers['mcp-session-id'],
            'mcp-protocol-version': req.headers['mcp-protocol-version'],
            // Indicate auth header presence without revealing token
            'authorization': req.headers.authorization ? 'Bearer [redacted]' : undefined,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        component: componentName
    };
    
    log4js.getLogger(componentName).info(logData);
    
    return logData;
};

// Helper function to log HTTP responses in a structured way
export const logHttpResponse = (res, duration, componentName = 'api') => {
    const logData = {
        type: 'response',
        statusCode: res.statusCode,
        duration: duration,
        component: componentName
    };
    
    log4js.getLogger(componentName).info(logData);
    
    return logData;
};

// Export default logger for backwards compatibility
export default logger;