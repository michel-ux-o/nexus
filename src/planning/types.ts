import type { Note, SaveStatus } from '../types';

export type View = 'menu' | 'home' | 'tasks' | 'notes' | 'today' | 'week' | 'calendar' | 'reminders' | 'settings' | 'ai';
export type TaskStatus = 'open' | 'progress' | 'done';
export type Priority = 'low' | 'normal' | 'high' | null;
export type TaskPlan = { kind: 'day'; date: string } | { kind: 'week'; weekStart: string } | null;
export interface SubtaskChild { id: string; title: string; done: boolean; suggestion: boolean }
export interface Subtask extends SubtaskChild { children?: SubtaskChild[] }
export interface SubtaskTemplate { title: string; suggestion: boolean; children?: { title: string; suggestion: boolean }[] }
export interface MorningRoutineDay { weekday: number; enabled: boolean; subtasks: Subtask[] }
export interface MorningRoutineSettings { days: MorningRoutineDay[] }
/** The date is the stable local calendar occurrence; receipts survive task deletion. */
export interface MorningRoutineReceipt { date: string; taskId: string; skipped: boolean }
export interface Task { id: string; title: string; description: string; status: TaskStatus; priority: Priority; estimatedMinutes: number | null; dueDate: string | null; plan: TaskPlan; subtasks: Subtask[]; noteIds: string[]; tags?: string[]; ruleId?: string; occurrenceDate?: string; morningRoutineDate?: string; createdAt: string; updatedAt: string }
export interface Appointment { id: string; title: string; description: string; startAt: string; durationMinutes: number; allDay?: { startDate: string; endDate: string }; createdAt: string; updatedAt: string }
export interface TimeBlock { id: string; taskId: string; startAt: string; durationMinutes: number; createdAt: string; updatedAt: string }
export interface DayPlan { date: string; priorityTaskIds: string[]; note: string; review: string; availableMinutes: number }
export interface WeekPlan { weekStart: string; goals: string; review: string }
export type RecurrenceFrequency = 'daily' | 'weekdays' | 'weekly';
export interface TaskRule { id: string; frequency: RecurrenceFrequency; startDate: string; endDate: string | null; paused: boolean; template: { title: string; description: string; priority: Priority; estimatedMinutes: number | null; tags: string[]; subtasks: SubtaskTemplate[]; noteIds: string[]; dueOffsetDays: number | null }; createdAt: string; updatedAt: string }
export interface RecurrenceReceipt { ruleId: string; date: string; taskId: string }
export interface Reminder { id: string; title: string; localStart: string; timeZone: string; frequency: 'once' | 'daily' | 'weekly'; enabled: boolean; taskId: string | null; appointmentId: string | null; createdAt: string; updatedAt: string }
export interface ReminderReceipt { id: string; reminderId: string; scheduledAt: string; status: 'pending' | 'done' | 'dismissed'; snoozedUntil: string | null; notifiedAt: string | null }
export interface ReminderOccurrence { id: string; reminder: Reminder; scheduledAt: string; effectiveAt: string; status: 'pending' | 'done' | 'dismissed'; adjusted: boolean }
export interface CapacityWindow { weekday: number; enabled: boolean; start: string; end: string }
export interface CapacitySettings { enabled: boolean; windows: CapacityWindow[]; bufferMinutes: number }
export type DashboardSection = 'priority' | 'tasks' | 'progress' | 'upcoming' | 'notes' | 'capture' | 'ai';
export type Theme = 'nexus' | 'daylight' | 'sand' | 'aurora' | 'system';
export type ArtifactIntensity = 'still' | 'atmospheric' | 'intense';
export interface AppSettings { theme?: Theme; artifactIntensity?: ArtifactIntensity; particleColor?: string; timeZone: string; startView: 'menu' | 'home' | 'last'; lastView: View; voiceReview: boolean; aiConsent: boolean; defaultAvailableMinutes: number; menuMotion?: 'still' | 'float' | 'orbit'; matrixBackground?: boolean; powerSaving?: boolean; dashboardSections?: DashboardSection[]; capacity?: CapacitySettings; notifications?: boolean; backupIntervalDays?: number; exportHistory?: string[]; onboardingDone?: boolean; morningRoutine?: MorningRoutineSettings }
export interface CaptureReceipt { itemId: string; taskId: string; appliedUpdatedAt: string; blockIds: string[] }
export interface CaptureOperation { id: string; createdAt: string; updatedAt: string; status: 'applied' | 'undone'; items: CaptureReceipt[] }
export interface PlanningData { tasks: Task[]; appointments: Appointment[]; timeBlocks: TimeBlock[]; days: DayPlan[]; weeks: WeekPlan[]; operations: CaptureOperation[]; settings: AppSettings; taskRules?: TaskRule[]; recurrenceReceipts?: RecurrenceReceipt[]; reminders?: Reminder[]; reminderReceipts?: ReminderReceipt[]; morningRoutineReceipts?: MorningRoutineReceipt[] }
export interface WorkspaceBackup { format: 'nexus-workspace'; version: 2 | 3 | 4; exportedAt: string; notes: Note[]; planning: PlanningData }
export const DEFAULT_MORNING_ROUTINE: MorningRoutineSettings = { days: Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, enabled: false, subtasks: [] })) };
export const DEFAULT_CAPACITY: CapacitySettings = { enabled: false, windows: Array.from({length: 7}, (_, i) => ({ weekday: i + 1, enabled: i < 5, start: '09:00', end: '17:00' })), bufferMinutes: 30 };
export const DEFAULT_DASHBOARD: DashboardSection[] = ['priority', 'tasks', 'progress', 'upcoming', 'notes', 'capture', 'ai'];
export const DEFAULT_SETTINGS: AppSettings = { theme: 'nexus', artifactIntensity: 'atmospheric', particleColor: '#8ebed4', timeZone: 'Europe/Berlin', startView: 'menu', lastView: 'menu', voiceReview: false, aiConsent: false, defaultAvailableMinutes: 480, menuMotion: 'float', matrixBackground: true, powerSaving: false, dashboardSections: DEFAULT_DASHBOARD, capacity: DEFAULT_CAPACITY, notifications: false, backupIntervalDays: 7, exportHistory: [], onboardingDone: false };
export function emptyPlanning(): PlanningData { return { tasks: [], appointments: [], timeBlocks: [], days: [], weeks: [], operations: [], taskRules: [], recurrenceReceipts: [], reminders: [], reminderReceipts: [], morningRoutineReceipts: [], settings: structuredClone(DEFAULT_SETTINGS) }; }
export interface TaskSaveOptions { rule?: TaskRule | null; reminder?: Reminder | null }

export interface CaptureItem {
  itemId: string; intent: 'create' | 'change' | 'delete' | 'unclear'; sourceText: string;
  title: string; description: string; priority: Priority; estimatedMinutes: number | null;
  dueDate: string | null; plannedDate: string | null; plannedWeek: string | null;
  startTime: string | null; durationMinutes: number | null; questions: string[]; suggestions: string[];
}
export interface CaptureContext { operationId: string; capturedAt: string; timeZone: string }
export interface CaptureCommit { operationId: string; items: CaptureItem[]; context: CaptureContext; noteIds?: string[] }
export interface CaptureResult { taskIds: string[]; skippedItemIds: string[] }
export interface UndoState { canUndo: boolean; label: string | null; count: number; busy: boolean; pending: boolean; error: string | null }
export interface PlannerSnapshot { undoState: UndoState; undoRevision: number; data: PlanningData; loading: boolean; loadError: string | null; status: SaveStatus; error: string | null }
export interface PlannerActions {
  undo?: () => Promise<void>;
  update: (updater: (data: PlanningData) => PlanningData, options?: { recordUndo?: boolean }) => void;
  saveTask: (task: Task, options?: TaskSaveOptions) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  setTaskStatus: (id: string, status: TaskStatus) => Promise<void>;
  moveTask: (id: string, plan: TaskPlan) => Promise<void>;
  saveAppointment: (appointment: Appointment) => Promise<void>;
  deleteAppointment: (id: string) => Promise<void>;
  saveTimeBlock: (block: TimeBlock) => Promise<void>;
  deleteTimeBlock: (id: string) => Promise<void>;
  updateDay: (day: DayPlan) => void;
  updateWeek: (week: WeekPlan) => void;
  updateSettings: (settings: Partial<AppSettings>) => void;
  commitCapture: (input: CaptureCommit) => Promise<CaptureResult>;
  undoCapture: (operationId: string, force?: boolean) => Promise<void>;
  flush: () => Promise<boolean>;
  retry: () => Promise<boolean>;
  reload: () => Promise<void>;
  setBlocked: (blocked: boolean) => void;
  saveTaskRule: (rule: TaskRule) => Promise<void>;
  materializeRecurring: (from: string, to: string) => Promise<void>;
  materializeMorningRoutine: (date: string) => Promise<void>;
  skipMorningRoutine: (date: string) => Promise<void>;
  saveReminder: (reminder: Reminder) => Promise<void>;
  deleteReminder: (id: string) => Promise<void>;
  acknowledgeReminder: (occurrence: ReminderOccurrence, status: 'done' | 'dismissed' | 'pending', snoozedUntil?: string | null) => Promise<void>;
  markReminderNotified: (occurrence: ReminderOccurrence) => Promise<void>;
}
export type Planner = PlannerSnapshot & PlannerActions;
export interface BlockDefaults { taskId?: string; date?: string; startAt?: string; durationMinutes?: number }
export interface PlannerViewProps { planner: Planner; notes: Note[]; onEditTask: (task?: Task, defaults?: Partial<Task>) => void; onEditAppointment: (appointment?: Appointment, date?: string, defaults?: Partial<Appointment>) => void; onEditBlock: (block?: TimeBlock, defaults?: BlockDefaults) => void; onOpenNote: (id: string) => void; onDictate: () => void; onAI: () => void }
export interface WorkspaceViewProps extends PlannerViewProps { onNavigate: (view: View) => void; onEditReminder: (reminder?: Reminder, defaults?: Partial<Reminder>) => void; onCreateNote: () => void; onQuickCapture: () => void }
