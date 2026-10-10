CREATE TABLE `cycle_point` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scheme_id` text NOT NULL,
	`date` text NOT NULL,
	`position` integer NOT NULL,
	`reason` text DEFAULT 'extra' NOT NULL,
	`ref_session_id` integer,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`scheme_id`) REFERENCES `split_scheme`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ref_session_id`) REFERENCES `workout_session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cycle_point_scheme_date` ON `cycle_point` (`scheme_id`,`date`,`id`);--> statement-breakpoint
CREATE INDEX `cycle_point_session` ON `cycle_point` (`ref_session_id`);--> statement-breakpoint
ALTER TABLE `workout_session` ADD `is_extra` integer DEFAULT false NOT NULL;