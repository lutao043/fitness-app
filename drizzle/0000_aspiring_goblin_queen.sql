CREATE TABLE `anchor_proposal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`suggested_position` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `body_metric` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`slot` text DEFAULT 'morning' NOT NULL,
	`weight_kg` real NOT NULL,
	`body_fat_pct` real,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `body_metric_date_slot` ON `body_metric` (`date`,`slot`);--> statement-breakpoint
CREATE TABLE `cheat_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cheat_setting` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`interval_days` integer DEFAULT 8 NOT NULL,
	`anchor_date` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `checkin` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkin_date_kind_ref` ON `checkin` (`date`,`kind`,`ref_id`);--> statement-breakpoint
CREATE INDEX `checkin_date` ON `checkin` (`date`);--> statement-breakpoint
CREATE TABLE `cycle_exercise` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`template_id` integer NOT NULL,
	`mode` text NOT NULL,
	`exercise_id` integer NOT NULL,
	`order_no` integer NOT NULL,
	`target_sets` integer NOT NULL,
	`target_reps` integer NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `cycle_template`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exercise_id`) REFERENCES `exercise`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cycle_exercise_template_mode` ON `cycle_exercise` (`template_id`,`mode`);--> statement-breakpoint
CREATE TABLE `cycle_template` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scheme_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`is_rest` integer DEFAULT false NOT NULL,
	`muscles` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`scheme_id`) REFERENCES `split_scheme`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cycle_template_scheme_position` ON `cycle_template` (`scheme_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `cycle_template_scheme_name` ON `cycle_template` (`scheme_id`,`name`);--> statement-breakpoint
CREATE TABLE `exercise` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`muscles` text NOT NULL,
	`type` text NOT NULL,
	`equip` text NOT NULL,
	`load_mode` text NOT NULL,
	`bar_kg` real,
	`default_sets` integer DEFAULT 4 NOT NULL,
	`default_reps` integer DEFAULT 12 NOT NULL,
	`base_weight` real,
	`home_ok` integer DEFAULT false NOT NULL,
	`note` text,
	`order_no` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_name` ON `exercise` (`name`);--> statement-breakpoint
CREATE TABLE `exercise_variant` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`exercise_id` integer NOT NULL,
	`code` text NOT NULL,
	`equip` text NOT NULL,
	`load_semantics` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`order_no` integer DEFAULT 0 NOT NULL,
	`base_weight` real,
	FOREIGN KEY (`exercise_id`) REFERENCES `exercise`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_variant_exercise_code` ON `exercise_variant` (`exercise_id`,`code`);--> statement-breakpoint
CREATE TABLE `holiday` (
	`date` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`source` text DEFAULT 'assistant' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `measurement` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`waist_cm` real,
	`chest_cm` real,
	`arm_cm` real,
	`thigh_cm` real,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `measurement_date` ON `measurement` (`date`);--> statement-breakpoint
CREATE TABLE `overtime` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`start_time` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `overtime_date` ON `overtime` (`date`);--> statement-breakpoint
CREATE TABLE `reminder_delivery` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`channel` text NOT NULL,
	`sent_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `reminder_event`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_delivery_event_channel` ON `reminder_delivery` (`event_id`,`channel`);--> statement-breakpoint
CREATE TABLE `reminder_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`ref_key` text NOT NULL,
	`date` text NOT NULL,
	`payload` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_event_type_ref_date` ON `reminder_event` (`type`,`ref_key`,`date`);--> statement-breakpoint
CREATE TABLE `schedule_anchor` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scheme_id` text NOT NULL,
	`anchor_date` text NOT NULL,
	`cycle_position` integer NOT NULL,
	`reason` text DEFAULT 'initial' NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`scheme_id`) REFERENCES `split_scheme`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedule_anchor_scheme` ON `schedule_anchor` (`scheme_id`,`id`);--> statement-breakpoint
CREATE TABLE `session_exercise` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`exercise_id` integer NOT NULL,
	`order_no` integer NOT NULL,
	`target_sets` integer NOT NULL,
	`target_reps` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workout_session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exercise_id`) REFERENCES `exercise`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `session_exercise_session` ON `session_exercise` (`session_id`,`order_no`);--> statement-breakpoint
CREATE TABLE `set_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_key` text,
	`session_id` integer NOT NULL,
	`exercise_id` integer NOT NULL,
	`set_no` integer NOT NULL,
	`weight_kg` real,
	`reps` integer,
	`duration_sec` integer,
	`variant_id` integer,
	`total_load_kg` real,
	`rest_before_sec` integer,
	`same_exercise` integer DEFAULT false NOT NULL,
	`done_at` text NOT NULL,
	`feel` text,
	`skipped` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workout_session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exercise_id`) REFERENCES `exercise`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `exercise_variant`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `set_log_client_key` ON `set_log` (`client_key`);--> statement-breakpoint
CREATE INDEX `set_log_session` ON `set_log` (`session_id`,`id`);--> statement-breakpoint
CREATE INDEX `set_log_exercise` ON `set_log` (`exercise_id`);--> statement-breakpoint
CREATE INDEX `set_log_done_at` ON `set_log` (`done_at`);--> statement-breakpoint
CREATE TABLE `skip_day` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skip_day_date` ON `skip_day` (`date`);--> statement-breakpoint
CREATE TABLE `split_scheme` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`order_no` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `supplement` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`times` text DEFAULT '[]' NOT NULL,
	`dose_text` text DEFAULT '' NOT NULL,
	`order_no` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nickname` text DEFAULT '我' NOT NULL,
	`height_cm` real,
	`target_weight_kg` real,
	`password_hash` text,
	`api_token_hash` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workout_session` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`date` text NOT NULL,
	`template_id` integer,
	`part` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`paused_sec` integer DEFAULT 0 NOT NULL,
	`rest_target_sec` integer DEFAULT 90 NOT NULL,
	`plan_snapshot` text,
	`summary` text,
	`feel` text,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `cycle_template`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workout_session_client_id` ON `workout_session` (`client_id`);--> statement-breakpoint
CREATE INDEX `workout_session_date` ON `workout_session` (`date`);--> statement-breakpoint
CREATE INDEX `workout_session_status` ON `workout_session` (`status`);