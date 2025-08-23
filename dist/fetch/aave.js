// Example of another updater (you can add more like this)
export class CustomProtocolUpdater {
    name = "Aave";
    async fetchData() {
        // Placeholder for another data source
        // This could fetch from another API, parse files, etc.
        return {
            "./aave-labels.json": {
                names: {
                // Example: "CUSTOM_PROTOCOL_ABC123": "Custom Protocol Market ABC"
                },
                shortNames: {
                // Example: "CUSTOM_PROTOCOL_ABC123": "CP ABC"
                },
            },
            "./aave-oracles.json": {},
        };
    }
    defaults = {};
}
