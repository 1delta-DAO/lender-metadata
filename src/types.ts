export type DisplayItem = {
  id: string;
  label: string;
  group?: string | null;
};

export type DisplayData = {
  items: DisplayItem[];
};

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface DataUpdater {
  name: string;
  defaults: any;
  targetFile?: string; // Optional custom target file path (fallback for single file)
  fetchData(): Promise<{ [file: string]: Partial<any> }>;
  transformData?(data: any): Partial<any>;
  mergeData?(oldData: any, data: any, fileKey: string): Partial<any>;
}

export interface UpdateOptions {
  appendOnly?: boolean;
  force?: boolean;
  targetFile?: string; // Override target file for this update
}

export interface UpdateResult<T = any> {
  data: T;
  added: number;
  updated: number;
  targetFile: string;
}

export interface MultiFileUpdateResult {
  results: { [file: string]: UpdateResult<any> };
  totalAdded: number;
  totalUpdated: number;
}
