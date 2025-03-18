// src/lib/util/logger.ts

/**
 * Log levels for the application
 */
export enum LogLevel {
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR',
    FATAL = 'FATAL'
  }
  
  /**
   * Log entry structure
   */
  export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
    component?: string;
    requestId?: string;
    context?: Record<string, any>;
    error?: {
      message: string;
      stack?: string;
      code?: string | number;
    };
  }
  
  /**
   * Logger configuration options
   */
  export interface LoggerConfig {
    minLevel: LogLevel;
    includeTimestamp: boolean;
    includeContext: boolean;
    colorize: boolean;
  }
  
  /**
   * Default configuration for the logger
   */
  const DEFAULT_CONFIG: LoggerConfig = {
    minLevel: LogLevel.INFO,
    includeTimestamp: true,
    includeContext: true,
    colorize: true
  };
  
  /**
   * ANSI color codes for terminal output
   */
  const COLORS = {
    reset: '\x1b[0m',
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    brightRed: '\x1b[91m',
    brightYellow: '\x1b[93m'
  };
  
  /**
   * Logger service for structured logging
   */
  export class Logger {
    private config: LoggerConfig;
    private component?: string;
    private requestId?: string;
  
    constructor(config?: Partial<LoggerConfig>, component?: string) {
      this.config = { ...DEFAULT_CONFIG, ...config };
      this.component = component;
    }
  
    /**
     * Create a child logger with component and/or request ID context
     */
    child(options: { component?: string; requestId?: string }): Logger {
      const childLogger = new Logger(this.config, options.component || this.component);
      childLogger.requestId = options.requestId || this.requestId;
      return childLogger;
    }
  
    /**
     * Set the request ID for the current logger instance
     */
    setRequestId(requestId: string): void {
      this.requestId = requestId;
    }
  
    /**
     * Log at DEBUG level
     */
    debug(message: string, context?: Record<string, any>): void {
      this.log(LogLevel.DEBUG, message, context);
    }
  
    /**
     * Log at INFO level
     */
    info(message: string, context?: Record<string, any>): void {
      this.log(LogLevel.INFO, message, context);
    }
  
    /**
     * Log at WARN level
     */
    warn(message: string, context?: Record<string, any>): void {
      this.log(LogLevel.WARN, message, context);
    }
  
    /**
     * Log at ERROR level
     */
    error(message: string, errorOrContext?: Error | Record<string, any>, context?: Record<string, any>): void {
      if (errorOrContext instanceof Error) {
        this.log(LogLevel.ERROR, message, context, errorOrContext);
      } else {
        this.log(LogLevel.ERROR, message, errorOrContext);
      }
    }
  
    /**
     * Log at FATAL level
     */
    fatal(message: string, errorOrContext?: Error | Record<string, any>, context?: Record<string, any>): void {
      if (errorOrContext instanceof Error) {
        this.log(LogLevel.FATAL, message, context, errorOrContext);
      } else {
        this.log(LogLevel.FATAL, message, errorOrContext);
      }
    }
  
    /**
     * Internal log method
     */
    private log(level: LogLevel, message: string, context?: Record<string, any>, error?: Error): void {
      // Skip if below minimum log level
      if (!this.shouldLog(level)) {
        return;
      }
  
      const timestamp = new Date().toISOString();
      
      // Extract error details if an error is provided
      const errorDetails = error ? {
        message: error.message,
        stack: error.stack,
        code: (error as any).code
      } : undefined;
  
      // Prepare the log entry
      const entry: LogEntry = {
        timestamp,
        level,
        message,
        component: this.component,
        requestId: this.requestId,
        context: this.config.includeContext ? context : undefined,
        error: errorDetails
      };
  
      // Output the log entry
      this.output(entry);
    }
  
    /**
     * Check if this log level should be logged
     */
    private shouldLog(level: LogLevel): boolean {
      const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR, LogLevel.FATAL];
      const configLevelIndex = levels.indexOf(this.config.minLevel);
      const messageLevelIndex = levels.indexOf(level);
      
      return messageLevelIndex >= configLevelIndex;
    }
  
    /**
     * Output the log entry
     */
    private output(entry: LogEntry): void {
      // For proper structured logging in production, typically this would send
      // to a service like Winston, Pino, or a cloud logging service.
      // For now, we'll just log to the console with some formatting.
  
      if (this.config.colorize) {
        this.colorizedConsoleOutput(entry);
      } else {
        // In production, we'd use JSON format for machine parsing
        console.log(JSON.stringify(entry));
      }
    }
  
    /**
     * Output colorized log for development
     */
    private colorizedConsoleOutput(entry: LogEntry): void {
      // Select color based on log level
      let color = COLORS.reset;
      switch (entry.level) {
        case LogLevel.DEBUG:
          color = COLORS.cyan;
          break;
        case LogLevel.INFO:
          color = COLORS.green;
          break;
        case LogLevel.WARN:
          color = COLORS.yellow;
          break;
        case LogLevel.ERROR:
          color = COLORS.red;
          break;
        case LogLevel.FATAL:
          color = COLORS.brightRed;
          break;
      }
  
      // Format the base log message
      let logMessage = `${color}[${entry.level}]${COLORS.reset}`;
      
      if (this.config.includeTimestamp) {
        logMessage += ` ${COLORS.blue}${entry.timestamp}${COLORS.reset}`;
      }
      
      if (entry.component) {
        logMessage += ` ${COLORS.magenta}[${entry.component}]${COLORS.reset}`;
      }
      
      if (entry.requestId) {
        logMessage += ` ${COLORS.cyan}(${entry.requestId})${COLORS.reset}`;
      }
      
      logMessage += `: ${entry.message}`;
      
      // Log the base message
      console.log(logMessage);
      
      // Log context if present
      if (entry.context && Object.keys(entry.context).length > 0) {
        console.log(`${COLORS.cyan}Context:${COLORS.reset}`, entry.context);
      }
      
      // Log error details if present
      if (entry.error) {
        console.log(`${COLORS.red}Error: ${entry.error.message}${COLORS.reset}`);
        if (entry.error.stack) {
          console.log(`${COLORS.yellow}Stack trace:${COLORS.reset}\n${entry.error.stack}`);
        }
      }
    }
  }
  
  // Export a default logger instance
  export const logger = new Logger();
  
  // Example usage:
  // import { logger } from '../util/logger';
  // logger.info('Processing webhook', { appointmentId: 'abc123' });
  // logger.error('Failed to delete appointment', new Error('Delete failed'), { appointmentId: 'abc123' });