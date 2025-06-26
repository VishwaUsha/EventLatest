/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/ui/serverWidget', 'N/runtime', 'N/query', 'N/url', 'N/file', 'N/log'],
function (serverWidget, runtime, query, url, file, log) {

    const DEFAULT_PAGE_SIZE = 50;

    // Define meaningful column headers
    const COLUMN_HEADERS_MAP = {
        row_num: 'Row Number',
        itemid: 'Item ID',
        //parentitem: 'Parent Item',
        description: 'Description',
        preferredvendor: 'Preferred Vendor',
        quantityonhand: 'Quantity',
        //quantitycommitted: 'Quantity Committed',
        quantityavailable: 'Available',
        quantitybackordered: 'Back Ordered',
        quantityonorder: 'On Order',
        
        reorderpoint: 'Reorder Point',
        preferredstocklevel: 'Preferred Stock Level',
        //leadtime: 'Lead Time (Days)',
        
        purchaseprice: 'Purchase Price',
        //averagecost: 'Average Cost',
        //lastpurchaseprice: 'Last Purchase Price',
        //firstsold: 'First Sold Date',
        //lastsold: 'Last Sold Date',
        //firstpurchased: 'First Purchased Date',
        //lastpurchased: 'Last Purchased Date',
        //qtysold30days: 'Qty Sold (30 Days)',
        //qtysold90days: 'Qty Sold (90 Days)',
        //qtysold1year: 'Qty Sold (1 Year)',
        //qtysoldlifetime: 'Qty Sold (Lifetime)'
    };

    function onRequest(context) {
        const request = context.request;
        const response = context.response;

        const scriptId = runtime.getCurrentScript().id;
        const deploymentId = runtime.getCurrentScript().deploymentId;
        
        // Get the selected location ID from either form submission or URL parameters
        const selectedLocationId = request.parameters.custpage_location_filter || request.parameters.selected_location_id || '';
        const currentPage = parseInt(request.parameters.page, 10) || 1;
        const exportExcel = request.parameters.exportExcel === 'true';

        log.debug('Request Parameters', {
            selectedLocationId: selectedLocationId,
            currentPage: currentPage,
            exportExcel: exportExcel
        });

        let locationNameForSuiteQL = '';
        if (selectedLocationId) {
            try {
                // Resolve location name from ID for SuiteQL filtering
                const locationResult = query.runSuiteQL({
                    query: `SELECT name FROM location WHERE id = ?`,
                    params: [parseInt(selectedLocationId, 10)]
                }).asMappedResults();
                if (locationResult.length > 0) {
                    locationNameForSuiteQL = locationResult[0].name;
                }
            } catch (e) {
                log.error('Error resolving location name from ID', e.message);
            }
        }
        log.debug('Resolved Location Name for SuiteQL', locationNameForSuiteQL);

        if (exportExcel) {
            // Pass the location ID for export, generateExcel will resolve name again
            return generateExcel(selectedLocationId, response);
        }

        const form = serverWidget.createForm({ title: 'Item Summary by Location' });
        
        // Hidden field to store selected location ID for client-side use
        form.addField({
            id: 'custpage_hidden_location_id',
            type: serverWidget.FieldType.TEXT,
            label: 'Hidden Location ID',
            isHidden: true
        }).defaultValue = selectedLocationId;
        form.getField({ id: 'custpage_hidden_location_id' }).updateDisplayType({
    displayType: serverWidget.FieldDisplayType.HIDDEN
});


        let results = [];
        let totalCount = 0;
        let totalPages = 0;

        if (locationNameForSuiteQL) { // Only run search if a valid location name is found
            try {
                const startRow = (currentPage - 1) * DEFAULT_PAGE_SIZE + 1;
                const endRow = currentPage * DEFAULT_PAGE_SIZE;

                const countSQL = `
                    SELECT COUNT(*) AS total
                    FROM item i
                    JOIN aggregateitemlocation ail ON i.id = ail.item
                    JOIN location l ON ail.location = l.id
                    WHERE i.isinactive = 'F' AND l.name = ?
                `;

                const baseSQL = `
                    WITH PaginatedResults AS (
                    SELECT
                    ROW_NUMBER() OVER (ORDER BY i.itemid ASC) AS row_num,
                    i.itemid As 'Item Name',
                    l.name AS Location,
                    BUILTIN.DF(i.parent) AS parentitem,
                    i.description,
                    ail.quantitybackordered,  ail.quantityonorder,
                    ail.reorderpoint,
                    ail.preferredstocklevel,
                    nvl(ail.quantitybackordered,0) +  ail.preferredstocklevel as quantity,
                    v.companyname AS preferredvendor, 
                    iv.purchaseprice as 'Rate foreign currency',
                    (SELECT
                        c.symbol AS 'currency symbol'
                    FROM
                        itemvendor iv 
                    JOIN subsidiary s ON iv.subsidiary = s.id
                    JOIN currency c ON s.currency= c.id
                    WHERE
                        iv.preferredvendor = 'T'
                        AND iv.subsidiary = 3 and  iv.item=i.id) AS 'currency symbol',
                    (
                        SELECT uom.abbreviation
                        FROM item i2
                        JOIN unitstype u ON i2.unitstype = u.id
                        JOIN unitstypeuom uom ON uom.unitstype = u.id
                        WHERE i2.id = i.id
                        AND uom.internalid = 1  -- adjust this to match your default unit
                    ) AS Unit,
                    (nvl(ail.quantitybackordered,0) +  ail.preferredstocklevel) *  ROUND(iv.purchaseprice, 4) as 'Total foreign currency',
                    iv.purchaseprice as rate,
                    (nvl(ail.quantitybackordered,0) +  ail.preferredstocklevel) * iv.purchaseprice as total
                    FROM
                    item i
                    JOIN aggregateitemlocation ail ON i.id = ail.item
                    JOIN location l ON ail.location = l.id
                    LEFT JOIN itemvendor iv ON iv.item = i.id AND iv.preferredvendor = 'T'
                    LEFT JOIN vendor v ON iv.vendor = v.id
                    WHERE
                    i.isinactive = 'F' AND l.name = ?
                  )
                    
                    SELECT * FROM PaginatedResults WHERE row_num BETWEEN ${startRow} AND ${endRow}
                `;
                const resultSet = query.runSuiteQL({ query: baseSQL, params: [locationNameForSuiteQL] });
                results = resultSet.asMappedResults();

                const countSet = query.runSuiteQL({ query: countSQL, params: [locationNameForSuiteQL] });
                totalCount = countSet.asMappedResults()[0].total;
                totalPages = Math.ceil(totalCount / DEFAULT_PAGE_SIZE);

                log.debug('Total Records Fetched', results.length);

            } catch (e) {
                log.error('SuiteQL Error', e.message);
                form.addField({
                    id: 'custpage_error_message',
                    label: 'Error',
                    type: serverWidget.FieldType.INLINEHTML
                }).defaultValue = `<p style="color: red;">An error occurred while fetching data: ${e.message}</p>`;
            }
        }

        // --- Start of HTML and Styling Section ---
        let html = `
            <style>
                /* General Body and Form Styling */
                body {
                    font-family: Arial, sans-serif;
                    background-color: #f0f0f0; /* Light background for the page */
                    color: #333;
                }
                form {
                    background-color: #fff;
                    padding: 20px;
                    border-radius: 8px;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                    margin: 20px auto;
                    max-width: 95%; /* Adjust width as needed */
                }

                /* Container for dropdown and buttons */
                .filter-controls {
                    display: flex;
                    align-items: flex-end; /* Align items to the bottom */
                    gap: 10px; /* Space between items */
                    margin-bottom: 20px;
                }
                .filter-controls > div {
                    flex-shrink: 0; /* Prevent items from shrinking */
                }
                .filter-controls .nlfield {
                    margin-bottom: 0 !important; /* Remove default field bottom margin */
                }
                .filter-controls .nllabel {
                    margin-bottom: 5px; /* Space between label and select */
                    display: block; /* Ensure label is on its own line */
                }
                
                /* NetSuite's Select field styling (adjust if necessary) */
                .filter-controls select {
                    padding: 7px 10px;
                    border: 1px solid #ccc;
                    border-radius: 4px;
                    font-size: 13px;
                    min-width: 200px; /* Adjust as needed */
                }

                /* Custom Button Styling */
                .custom-button {
                    background-color: #007bff; /* Blue */
                    color: white;
                    padding: 8px 15px;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 14px;
                    transition: background-color 0.3s ease;
                    height: 35px; /* Match height of the select for better alignment */
                }
                .custom-button:hover {
                    background-color: #0056b3; /* Darker blue on hover */
                }

                /* Record count display */
                .record-count {
                    margin-bottom: 15px;
                    font-weight: bold;
                    color: #555;
                    font-size: 14px;
                    text-align: center;
                }

                /* Table Styling */
                .item-summary-table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 10px; /* Adjusted margin */
                    font-family: Arial, sans-serif;
                    font-size: 12px;
                }
                .item-summary-table th, .item-summary-table td {
                    border: 1px solid #ddd;
                    padding: 8px;
                    text-align: left;
                    white-space: nowrap; /* Prevent text wrapping in cells */
                    overflow: hidden;
                    text-overflow: ellipsis; /* Add ellipsis for overflowed text */
                    max-width: 150px; /* Max width for columns before ellipsis, adjust as needed */
                }
                .item-summary-table th {
                    background-color: #f2f2f2;
                    font-weight: bold;
                    color: #333;
                }
                .item-summary-table tr:nth-child(even) {
                    background-color: #f9f9f9;
                }
                .item-summary-table tr:hover {
                    background-color: #f1f1f1;
                }
                /* Pagination Links Styling */
                .pagination-links {
                    margin-top: 15px;
                    font-size: 14px;
                    text-align: center;
                }
                .pagination-links a {
                    margin: 0 8px;
                    text-decoration: none;
                    color: #007bff;
                    padding: 5px 10px;
                    border: 1px solid #007bff;
                    border-radius: 4px;
                    transition: background-color 0.3s ease, color 0.3s ease;
                }
                .pagination-links a:hover {
                    background-color: #007bff;
                    color: white;
                }
            </style>
            
            <div class="filter-controls">
                <div class="nlfield">
                    <label class="nllabel" for="custpage_location_filter_html">LOCATION NAME</label>
                    <select id="custpage_location_filter_html" name="custpage_location_filter_html">
                        <option value="">- Select Location -</option>
                        `;
                        // Populate the HTML select dropdown
                        const locations = query.runSuiteQL({ query: `SELECT id, name FROM location WHERE isinactive = 'F' ORDER BY name` }).asMappedResults();
                        locations.forEach(loc => {
                            const selected = (loc.id.toString() === selectedLocationId) ? 'selected' : '';
                            html += `<option value="${loc.id}" ${selected}>${loc.name}</option>`;
                        });
                        html += `
                    </select>
                </div>
                <button type="button" class="custom-button" onclick="submitSearch();">Search</button>
                <button type="button" class="custom-button" onclick="exportToExcel();">Export to Excel</button>
            </div>

            <div class="record-count">
                ${locationNameForSuiteQL ? `Displaying ${results.length} of ${totalCount} records across ${totalPages} pages for location: ${locationNameForSuiteQL}` : 'Please select a location to view results.'}
            </div>

            <table class="item-summary-table"><thead><tr>`;

        // Generate table headers using the map for meaningful names
        if (results.length > 0) {
            Object.keys(results[0]).forEach(h => {
                html += `<th>${COLUMN_HEADERS_MAP[h] || h}</th>`; // Use mapped name or default to SuiteQL alias
            });
        } else {
            // Fallback for headers if no results to ensure table structure
            Object.values(COLUMN_HEADERS_MAP).forEach(h => {
                html += `<th>${h}</th>`;
            });
        }
        html += '</tr></thead><tbody>';

        if (results.length > 0) {
            results.forEach(row => {
                html += '<tr>';
                Object.keys(row).forEach(key => {
                    const value = (row[key] !== null && row[key] !== undefined) ? row[key] : '';
                    html += `<td>${value}</td>`;
                });
                html += '</tr>';
            });
        } else {
            html += `<tr><td colspan="${Object.keys(COLUMN_HEADERS_MAP).length || 1}">No records found for the selected location or filters.</td></tr>`;
        }
        html += '</tbody></table>';

        html += '<div class="pagination-links">';
        if (currentPage > 1) {
            html += `<a href="${url.resolveScript({ scriptId, deploymentId, params: { page: currentPage - 1, selected_location_id: selectedLocationId } })}">Previous</a> `;
        }
        if (currentPage < totalPages) {
            html += `<a href="${url.resolveScript({ scriptId, deploymentId, params: { page: currentPage + 1, selected_location_id: selectedLocationId } })}">Next</a>`;
        }
        html += '</div>';

        // Add the HTML content to an INLINEHTML field
        form.addField({ id: 'custpage_content_area', label: ' ', type: serverWidget.FieldType.INLINEHTML }).defaultValue = html;

        // Client script for the buttons
        form.addField({ id: 'custpage_script_area', label: ' ', type: serverWidget.FieldType.INLINEHTML }).defaultValue = `
            <script>
                function submitSearch() {
                    var locationSelect = document.getElementById('custpage_location_filter_html');
                    var selectedId = locationSelect ? locationSelect.value : '';
                    // Construct URL to re-load Suitelet with selected location and reset to page 1
                    window.location.href = '${url.resolveScript({ scriptId, deploymentId })}&selected_location_id=' + encodeURIComponent(selectedId) + '&page=1';
                }

                function exportToExcel() {
                    var locationSelect = document.getElementById('custpage_location_filter_html');
                    var selectedId = locationSelect ? locationSelect.value : '';
                    // Construct URL for export, passing the selected location ID
                    window.location.href = '${url.resolveScript({ scriptId, deploymentId })}&exportExcel=true&selected_location_id=' + encodeURIComponent(selectedId);
                }
            </script>`;

        response.writePage(form);
    }

    function generateExcel(locationIdForExport, response) { // This now receives the location ID
        try {
            let allRecords = [];
            let locationNameForExport = '';

            if (locationIdForExport) {
                // Resolve location name from ID for SuiteQL filtering in export
                const locationResult = query.runSuiteQL({
                    query: `SELECT name FROM location WHERE id = ?`,
                    params: [parseInt(locationIdForExport, 10)]
                }).asMappedResults();
                if (locationResult.length > 0) {
                    locationNameForExport = locationResult[0].name;
                }
            }

            if (!locationNameForExport) {
                response.addHeader({ name: 'Content-Type', value: 'text/csv' });
                response.addHeader({ name: 'Content-Disposition', value: 'attachment; filename="ItemLocationSummary.csv"' });
                response.write('No location selected or found for export.');
                return;
            }

            const BATCH_SIZE = 5000;

            const countSQL = `
                SELECT COUNT(*) AS total
                FROM item i
                JOIN aggregateitemlocation ail ON i.id = ail.item
                JOIN location l ON ail.location = l.id
                WHERE i.isinactive = 'F' AND l.name = ?
            `;
            const countSet = query.runSuiteQL({ query: countSQL, params: [locationNameForExport] });
            const totalRecords = countSet.asMappedResults()[0].total;
            const totalBatches = Math.ceil(totalRecords / BATCH_SIZE);

            for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
                const startRow = batchNum * BATCH_SIZE + 1;
                const endRow = (batchNum + 1) * BATCH_SIZE;

                const exportSQL = `
                    WITH PaginatedResults AS (
                        SELECT
                        ROW_NUMBER() OVER (ORDER BY i.itemid ASC) AS row_num,
                        i.itemid AS 'Item Name',
                        l.name AS Location,
                        BUILTIN.DF(i.parent) AS parentitem,
                        i.description,
                        ail.quantitybackordered,  ail.quantityonorder,
                        ail.reorderpoint,
                        ail.preferredstocklevel,
                        nvl(ail.quantitybackordered,0) +  ail.preferredstocklevel as quantity,
                        v.companyname AS preferredvendor, 
                        iv.purchaseprice as 'Rate foreign currency',
                        (SELECT
                            c.symbol AS 'currency symbol'
                        FROM
                            itemvendor iv 
                        JOIN subsidiary s ON iv.subsidiary = s.id
                        JOIN currency c ON s.currency= c.id
                        WHERE
                            iv.preferredvendor = 'T'
                            AND iv.subsidiary = 3 and  iv.item=i.id) AS 'currency symbol',
                        (
                            SELECT uom.abbreviation
                            FROM item i2
                            JOIN unitstype u ON i2.unitstype = u.id
                            JOIN unitstypeuom uom ON uom.unitstype = u.id
                            WHERE i2.id = i.id
                            AND uom.internalid = 1  -- adjust this to match your default unit
                        ) AS Unit,
                        (nvl(ail.quantitybackordered,0) +  ail.preferredstocklevel) *  ROUND(iv.purchaseprice, 4) as 'Total foreign currency',
                        iv.purchaseprice as rate,
                        (nvl(ail.quantitybackordered,0) +  ail.preferredstocklevel) * iv.purchaseprice as total
                        FROM
                        item i
                        JOIN aggregateitemlocation ail ON i.id = ail.item
                        JOIN location l ON ail.location = l.id
                        LEFT JOIN itemvendor iv ON iv.item = i.id AND iv.preferredvendor = 'T'
                        LEFT JOIN vendor v ON iv.vendor = v.id
                    WHERE
                    i.isinactive = 'F' AND l.name = ?
                  )
  
                    
                    SELECT * FROM PaginatedResults WHERE row_num BETWEEN ${startRow} AND ${endRow};
                `;
                const resultSet = query.runSuiteQL({ query: exportSQL, params: [locationNameForExport] });
                const batch = resultSet.asMappedResults();
                allRecords = allRecords.concat(batch);

                log.debug('Export Batch Processed', `Batch: ${batchNum + 1}/${totalBatches}, Records: ${batch.length}, Total Collected: ${allRecords.length}, Governance: ${runtime.getCurrentScript().getRemainingUsage()}`);

                if (batch.length < BATCH_SIZE && batchNum < totalBatches - 1) {
                    break;
                }
            }

            if (allRecords.length === 0) {
                response.addHeader({ name: 'Content-Type', value: 'text/csv' });
                response.addHeader({ name: 'Content-Disposition', value: 'attachment; filename="ItemLocationSummary.csv"' });
                response.write('No records found for the selected location.');
                return;
            }

            let csvRows = [];
            // Use the COLUMN_HEADERS_MAP for CSV headers
            const headers = Object.keys(allRecords[0]);
            csvRows.push(headers.map(h => `"${COLUMN_HEADERS_MAP[h] || h}"`).join(',')); // Escape and map headers

            allRecords.forEach(row => {
                const rowValues = headers.map(key => {
                    let value = row[key];
                    if (value === null || value === undefined) {
                        value = '';
                    } else if (typeof value === 'string') {
                        value = value.replace(/"/g, '""'); // Escape double quotes within string values
                    }
                    return `"${value}"`; // Wrap all values in double quotes
                });
                csvRows.push(rowValues.join(','));
            });

            response.addHeader({ name: 'Content-Type', value: 'text/csv' });
            response.addHeader({ name: 'Content-Disposition', value: 'attachment; filename="ItemLocationSummary.csv"' });
            response.write(csvRows.join('\n'));

        } catch (e) {
            log.error('Excel Export Error', e.message);
            response.write('Error generating file: ' + e.message);
        }
    }

    return { onRequest };
});