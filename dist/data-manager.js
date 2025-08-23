// ============================================================================
// Main Data Manager
// ============================================================================
import { writeTextIfChanged, write } from "./io.js";
import { loadExisting, mergeData } from "./utils.js";
import { sha256Hex } from "./hash.js";
export class DataManager {
    updaters = [];
    registerUpdater(updater) {
        this.updaters.push(updater);
    }
    /**
     * Get the target file path for an updater
     */
    getTargetFile(updater, options = {}) {
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
     * Update data from a specific source
     */
    async updateFromSource(updaterName, options = {}) {
        const updater = this.updaters.find((u) => u.name === updaterName);
        if (!updater) {
            return { success: false, error: `Updater '${updaterName}' not found` };
        }
        try {
            console.log(`Fetching data from ${updater.name}...`);
            const incomingData = await updater.fetchData();
            // Apply transformData if available
            const transformedData = updater.transformData
                ? updater.transformData(incomingData)
                : incomingData;
            const targetFile = this.getTargetFile(updater, options);
            const existing = await loadExisting(targetFile);
            // Use the updater's defaults
            const defaults = updater.defaults || {};
            let result;
            if (updater.mergeData) {
                // Use custom merge function if provided
                const customMerged = updater.mergeData(existing, transformedData);
                result = mergeData(existing, customMerged, defaults, options);
            }
            else {
                // Use standard merge
                result = mergeData(existing, transformedData, defaults, options);
            }
            return {
                success: true,
                result: {
                    ...result,
                    targetFile,
                },
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    }
    /**
     * Update data from all sources, each to their own target file
     */
    async updateAll(options = {}) {
        const results = [];
        const additionalData = {};
        for (const updater of this.updaters) {
            console.log(`Processing ${updater.name}...`);
            try {
                const updateResult = await this.updateFromSource(updater.name, options);
                if (updateResult.success && updateResult.result) {
                    results.push(updateResult.result);
                    console.log(`  ${updater.name}: +${updateResult.result.added} added, ${updateResult.result.updated} updated -> ${updateResult.result.targetFile}`);
                }
                else {
                    console.error(`Failed to update from ${updater.name}:`, updateResult.error);
                }
            }
            catch (error) {
                console.error(`Failed to update from ${updater.name}:`, error);
            }
        }
        // Write all results to their respective files
        await this.writeAllResults(results, additionalData, options);
    }
    /**
     * Update and merge all sources into a single target file
     */
    async updateAllToSingleFile(targetFile = "data/latest.json", options = {}) {
        // Start with empty data structure - we'll merge updater defaults as we go
        let currentData = {};
        let totalAdded = 0;
        let totalUpdated = 0;
        // Collect all additional data (like oracles) separately
        const additionalData = {};
        for (const updater of this.updaters) {
            console.log(`Processing ${updater.name}...`);
            try {
                const incomingData = await updater.fetchData();
                // Apply transformData if available
                const transformedData = updater.transformData
                    ? updater.transformData(incomingData)
                    : incomingData;
                // Use updater's specific defaults for this merge
                const updaterDefaults = updater.defaults || {};
                let dataToMerge = transformedData;
                if (updater.mergeData) {
                    // Use custom merge function if provided
                    dataToMerge = updater.mergeData(currentData, transformedData);
                }
                // Separate known fields from additional data
                const { oracles, ...knownFields } = dataToMerge;
                // Merge the known fields with updater-specific defaults
                const result = mergeData(currentData, knownFields, updaterDefaults, options);
                currentData = result.data;
                totalAdded += result.added;
                totalUpdated += result.updated;
                // Collect additional data (like oracles)
                if (oracles) {
                    additionalData.oracles = { ...additionalData.oracles, ...oracles };
                }
                // Collect any other additional fields
                for (const [key, value] of Object.entries(dataToMerge)) {
                    if (key !== "names" && key !== "shortNames" && key !== "oracles") {
                        if (!additionalData[key]) {
                            additionalData[key] = {};
                        }
                        Object.assign(additionalData[key], value);
                    }
                }
                console.log(`  ${updater.name}: +${result.added} added, ${result.updated} updated`);
            }
            catch (error) {
                console.error(`Failed to update from ${updater.name}:`, error);
            }
        }
        // Write the combined result
        await this.writeResults({
            data: currentData,
            added: totalAdded,
            updated: totalUpdated,
            targetFile,
        }, additionalData);
    }
    /**
     * Write results for individual updater files
     */
    async writeAllResults(results, additionalData, options = {}) {
        const writtenFiles = [];
        // Write each result to its target file
        for (const result of results) {
            const payload = JSON.stringify(result.data, null, 2) + "\n";
            const wrote = await writeTextIfChanged(result.targetFile, payload);
            if (wrote !== "skipped") {
                writtenFiles.push(result.targetFile);
            }
        }
        // Write additional data files
        const additionalWrites = [];
        for (const [key, data] of Object.entries(additionalData)) {
            if (data && Object.keys(data).length > 0) {
                const filename = `data/${key}.json`;
                const content = JSON.stringify(data, null, 2) + "\n";
                await write(filename, content);
                additionalWrites.push(filename);
            }
        }
        // Create a summary manifest
        const totalAdded = results.reduce((sum, r) => sum + r.added, 0);
        const totalUpdated = results.reduce((sum, r) => sum + r.updated, 0);
        const manifest = {
            version: new Date().toISOString().replace(/[:.]/g, "-"),
            generatedAt: new Date().toISOString(),
            totalAdded,
            totalUpdated,
            updatedFiles: writtenFiles,
            additionalFiles: additionalWrites,
            results: results.map((r) => ({
                targetFile: r.targetFile,
                added: r.added,
                updated: r.updated,
            })),
        };
        await writeTextIfChanged("data/update-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
        // Log results
        if (writtenFiles.length === 0 && additionalWrites.length === 0) {
            console.log("No changes detected across all updaters.");
        }
        else {
            console.log("Update completed:", {
                totalAdded,
                totalUpdated,
                filesUpdated: writtenFiles.length,
                additionalFiles: additionalWrites.length,
            });
        }
    }
    /**
     * Write results for single file updates (legacy support)
     */
    async writeResults(result, additionalData) {
        // Write main data
        const payload = JSON.stringify(result.data, null, 2) + "\n";
        const sha = sha256Hex(payload);
        const manifest = {
            version: sha.slice(0, 12),
            generatedAt: new Date().toISOString(),
            sha256: sha,
            added: result.added,
            updated: result.updated,
            targetFile: result.targetFile,
        };
        const wroteData = await writeTextIfChanged(result.targetFile, payload);
        // Write additional data files
        const additionalWrites = [];
        for (const [key, data] of Object.entries(additionalData)) {
            if (data && Object.keys(data).length > 0) {
                const filename = `data/${key}.json`;
                const content = JSON.stringify(data, null, 2) + "\n";
                await write(filename, content);
                additionalWrites.push(filename);
            }
        }
        const wroteManifest = await writeTextIfChanged("data/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
        if (wroteData === "skipped" && wroteManifest === "skipped") {
            console.log("No changes detected.");
        }
        else {
            console.log("Dataset updated:", manifest);
            if (additionalWrites.length > 0) {
                console.log("Additional files written:", additionalWrites);
            }
        }
    }
    /**
     * Get list of registered updaters
     */
    getUpdaters() {
        return [...this.updaters];
    }
    /**
     * Get updater by name
     */
    getUpdater(name) {
        return this.updaters.find((u) => u.name === name);
    }
}
