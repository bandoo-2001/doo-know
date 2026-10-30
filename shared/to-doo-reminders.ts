import type { ToDooEntityMap } from './to-doo-contracts.js';

export type ToDooReminderCard = {
  event: ToDooEntityMap['reminderEvent'];
  section: 'tasks' | 'habits' | 'anniversaries' | 'notifications';
  taskId?: string;
  occurrenceId?: string;
  date?: string;
  completion: 'task' | 'habit' | 'acknowledge' | 'open';
  habit?: { amount: number; target: number; unit: string };
};
export type ToDooReminderFeed = {
  reminders: ToDooReminderCard[];
  missedCount: number;
  timeZone: string;
};
