// src/types/node-cron.d.ts

declare module 'node-cron' {
    interface ScheduledTask {
      start: () => void;
      stop: () => void;
    }
  
    function schedule(
      expression: string,
      func: () => void,
      options?: {
        scheduled?: boolean;
        timezone?: string;
      }
    ): ScheduledTask;
  
    function validate(expression: string): boolean;
  
    export { schedule, validate, ScheduledTask };
  }