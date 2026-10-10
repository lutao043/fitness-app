CREATE TABLE `body_analysis` (
	`date` text PRIMARY KEY NOT NULL,
	`level` text NOT NULL,
	`text` text NOT NULL,
	`source` text DEFAULT 'assistant' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
