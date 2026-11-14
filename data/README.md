HYDROVISION AI - NASA DATA DROP

Place the final analysis files in this folder:

1. basins_flood_analysis.csv
   Main analysis results. It should contain separate records for:
   - Babahoyo
   - Lower Guayas
   - Daule
   - Vinces

2. analysis_metadata.json
   Processing information, including:
   - NISAR event granule ID
   - Baseline granule/date
   - Processing dates
   - Classification thresholds
   - AOI and basin coverage
   - DEM source and processing notes
   - Known limitations

3. basins.geojson
   Basin boundaries, if available and needed for map display
   or rerunning the analysis.

IMPORTANT:
- Do not replace missing measurements with invented values.
- Do not label flooded area percentage as flood probability.
- Keep the CSV column names and basin names documented.
- The CSV must represent basin-level results if the dashboard
  is going to compare the four basins.
