import { invokeTauriCommand, isTauriRuntime } from "./runtime";

export interface DatabaseStatus {
	path: string;
	migrationVersion: number;
	startupCount: number;
}

function placeholderDatabaseStatus(): DatabaseStatus {
	return {
		path: "",
		migrationVersion: 0,
		startupCount: 0,
	};
}

export async function getDatabaseStatus(): Promise<DatabaseStatus> {
	if (!isTauriRuntime()) {
		return placeholderDatabaseStatus();
	}
	const raw = await invokeTauriCommand<DatabaseStatus>("get_database_status");
	return raw ?? placeholderDatabaseStatus();
}
