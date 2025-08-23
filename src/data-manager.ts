// ============================================================================
// Main Data Manager
// ============================================================================

import { writeTextIfChanged, write } from "./io.js";
import { loadExisting, mergeData } from "./utils.js";
import { sha256Hex } from "./hash.js";
import {
  DataUpdater,
  MultiFileUpdateResult,
  UpdateOptions,
  UpdateResult,
} from "./types.js";

export class DataManager {
  private updaters: DataUpdater[] = [];

  registerUpdater(updater: DataUpdater): void {
    this.updaters.push(updater);
  }

  /**
   * Get the target file path for an updater (fallback for single file operations)
   */
  private getTargetFile(
    updater: DataUpdater,
    options: UpdateOptions = {}
  ): string {
    // Priority: options.targetFile > updater.targetFile > default based on updater name
    if (options.targetFile) {
      return options.targetFile;
    }

    if (updater.targetFile) {
      return updater.targetFile;
    }

    // Generate default filename based on updater name
    const sanitizedName = updater.name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");

    return `data/${sanitizedName}-latest.json`;
  }

  /**
   * Get default file paths based on the data keys and updater name
   */
  private getFilePathsForData(fileDataMap: { [file: string]: any }): {
    [file: string]: string;
  } {
    const filePaths: { [file: string]: string } = {};

    for (const fileKey of Object.keys(fileDataMap)) {
      // If fileKey is already a path (contains / or .json), use it directly
      if (fileKey.includes("/") || fileKey.endsWith(".json")) {
        filePaths[fileKey] = fileKey;
      } else {
        // Otherwise, generate a path based on updater name and file key
        filePaths[fileKey] = `data/${fileKey}.json`;
      }
    }

    return filePaths;
  }

  /**
   * Update data from a specific source to multiple files
   */
  async updateFromSource(
    updaterName: string,
    options: UpdateOptions = {}
  ): Promise<{
    success: boolean;
    results?: { [file: string]: UpdateResult<any> };
    error?: string;
  }> {
    const updater = this.updaters.find((u) => u.name === updaterName);
    if (!updater) {
      return { success: false, error: `Updater '${updaterName}' not found` };
    }

    try {
      console.log(`Fetching data from ${updater.name}...`);
      const fileDataMap = await updater.fetchData();

      // Get file paths for each data key
      const filePaths = this.getFilePathsForData(fileDataMap);

      const results: { [file: string]: UpdateResult<any> } = {};
      let totalAdded = 0;
      let totalUpdated = 0;

      // Process each file
      for (const [fileKey, incomingData] of Object.entries(fileDataMap)) {
        const targetFile = filePaths[fileKey];

        // Apply transformData if available
        const transformedData = updater.transformData
          ? updater.transformData(incomingData)
          : incomingData;

        let existing: any = {};
        try {
          existing = await loadExisting(targetFile);
        } catch {}

        // Use the updater's defaults
        const defaults = updater.defaults || {};

        let result;
        if (updater.mergeData) {
          // Use custom merge function if provided
          result = updater.mergeData(existing, transformedData, fileKey) as any;
          // result = mergeData(existing, customMerged, defaults, options);
        } else {
          // Use standard merge
          result = mergeData(existing, transformedData, defaults, options);
        }

        results[fileKey] = {
          data: result,
          targetFile,
        };

        totalAdded += result.added;
        totalUpdated += result.updated;

        console.log(
          `  ${fileKey}: +${result.added} added, ${result.updated} updated -> ${targetFile}`
        );
      }

      return {
        success: true,
        results,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Update data from all sources, each to their respective files
   */
  async updateAll(options: UpdateOptions = {}): Promise<void> {
    const allResults: MultiFileUpdateResult[] = [];

    for (const updater of this.updaters) {
      console.log(`Processing ${updater.name}...`);

      try {
        const updateResult = await this.updateFromSource(updater.name, options);

        if (updateResult.success && updateResult.results) {
          allResults.push(updateResult.results as any);
          console.log(
            `${updateResult.results} updated across ${
              Object.keys(updateResult.results).length
            } files`
          );
        } else {
          console.error(
            `Failed to update from ${updater.name}:`,
            updateResult.error
          );
        }
      } catch (error) {
        console.error(`Failed to update from ${updater.name}:`, error);
      }
    }

    // Write all results to their respective files
    await this.writeAllResults(allResults);
  }

  /**
   * Update and merge all sources into files based on their data structure
   */
  async updateAllByDataType(options: UpdateOptions = {}): Promise<void> {
    // Group data by file type across all updaters
    const consolidatedData: { [fileType: string]: any[] } = {};
    const fileTypeToPath: { [fileType: string]: string } = {};

    for (const updater of this.updaters) {
      console.log(`Processing ${updater.name}...`);

      try {
        const fileDataMap = await updater.fetchData();

        // Process each file type from this updater
        for (const [fileKey, incomingData] of Object.entries(fileDataMap)) {
          // Apply transformData if available
          const transformedData = updater.transformData
            ? updater.transformData(incomingData)
            : incomingData;

          if (!consolidatedData[fileKey]) {
            consolidatedData[fileKey] = [];
            // Determine file path for this file type
            if (fileKey.includes("/") || fileKey.endsWith(".json")) {
              fileTypeToPath[fileKey] = fileKey;
            } else {
              fileTypeToPath[fileKey] = `data/${fileKey}.json`;
            }
          }

          consolidatedData[fileKey].push({
            updaterName: updater.name,
            data: transformedData,
            defaults: updater.defaults || {},
            mergeData: updater.mergeData,
          });
        }
      } catch (error) {
        console.error(`Failed to process ${updater.name}:`, error);
      }
    }

    // Now merge and write each file type
    const results: { [fileType: string]: UpdateResult<any> } = {};
    let totalAdded = 0;
    let totalUpdated = 0;

    for (const [fileType, updaterDataList] of Object.entries(
      consolidatedData
    )) {
      const targetFile = fileTypeToPath[fileType];
      const existing = await loadExisting(targetFile);

      let currentData = existing;

      // Merge data from all updaters for this file type
      for (const updaterData of updaterDataList) {
        let dataToMerge = updaterData.data;

        if (updaterData.mergeData) {
          // Use custom merge function if provided
          dataToMerge = updaterData.mergeData(currentData, updaterData.data);
        }

        const result = mergeData(
          currentData,
          dataToMerge,
          updaterData.defaults,
          options
        );
        currentData = result;
      }

      results[fileType] = {
        data: currentData,
        targetFile,
      };
    }

    // Write all consolidated results
    await this.writeConsolidatedResults(results);
  }

  /**
   * Write results for individual updater files
   */
  private async writeAllResults(
    allResults: MultiFileUpdateResult[]
  ): Promise<void> {
    const writtenFiles: string[] = [];
    const allFileResults: UpdateResult<any>[] = [];

    // Flatten all results
    for (const multiResult of allResults) {
      for (const result of Object.values(multiResult)) {
        allFileResults.push(result);
      }
    }

    // Write each result to its target file
    for (const result of allFileResults) {
      const payload = JSON.stringify(result.data, null, 2) + "\n";
      const wrote = await writeTextIfChanged(result.targetFile, payload);

      if (wrote !== "skipped") {
        writtenFiles.push(result.targetFile);
      }
    }

    // Create a summary manifest

    const manifest = {
      version: new Date().toISOString().replace(/[:.]/g, "-"),
      generatedAt: new Date().toISOString(),
      updatedFiles: writtenFiles,
      results: allFileResults.map((r) => ({
        targetFile: r.targetFile,
      })),
    };

    await writeTextIfChanged(
      "data/update-manifest.json",
      JSON.stringify(manifest, null, 2) + "\n"
    );

    // Log results
    if (writtenFiles.length === 0) {
      console.log("No changes detected across all updaters.");
    } else {
      console.log("Update completed:", {
        filesUpdated: writtenFiles.length,
      });
    }
  }

  /**
   * Write consolidated results (for updateAllByDataType)
   */
  private async writeConsolidatedResults(results: {
    [fileType: string]: UpdateResult<any>;
  }): Promise<void> {
    const writtenFiles: string[] = [];

    // Write each file type
    for (const [fileType, result] of Object.entries(results)) {
      const payload = JSON.stringify(result.data, null, 2) + "\n";
      const wrote = await writeTextIfChanged(result.targetFile, payload);

      if (wrote !== "skipped") {
        writtenFiles.push(result.targetFile);
      }
    }

    // Create manifest
    const manifest = {
      version: new Date().toISOString().replace(/[:.]/g, "-"),
      generatedAt: new Date().toISOString(),
      updatedFiles: writtenFiles,
      fileTypes: Object.keys(results),
      results: Object.entries(results).map(([fileType, result]) => ({
        fileType,
        targetFile: result.targetFile,
      })),
    };

    await writeTextIfChanged(
      "data/consolidated-manifest.json",
      JSON.stringify(manifest, null, 2) + "\n"
    );

    // Log results
    console.log("Consolidated update completed:", {
      filesUpdated: writtenFiles.length,
      fileTypes: Object.keys(results).length,
    });
  }

  /**
   * Get list of registered updaters
   */
  getUpdaters(): DataUpdater[] {
    return [...this.updaters];
  }

  /**
   * Get updater by name
   */
  getUpdater(name: string): DataUpdater | undefined {
    return this.updaters.find((u) => u.name === name);
  }
}
