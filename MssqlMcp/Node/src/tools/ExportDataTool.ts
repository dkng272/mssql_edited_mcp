import sql from "mssql";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import { ReadDataTool } from "./ReadDataTool.js";

export class ExportDataTool implements Tool {
  [key: string]: any;
  name = "export_data";
  description = "Exports SQL query results directly to a CSV file. Executes a SELECT query and writes results to the specified file path. More efficient than read_data for large datasets.";

  inputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "SQL SELECT query to execute (must start with SELECT). Example: SELECT * FROM MarketIndex WHERE COMGROUPCODE = 'VNINDEX' ORDER BY TRADINGDATE DESC"
      },
      outputPath: {
        type: "string",
        description: "Full file path where CSV should be saved. Example: /Users/username/Downloads/data/output.csv"
      },
      includeHeaders: {
        type: "boolean",
        description: "Whether to include column headers in CSV (default: true)",
        default: true
      }
    },
    required: ["query", "outputPath"],
  } as any;

  // Reuse security validation from ReadDataTool
  private readDataTool = new ReadDataTool();

  /**
   * Converts array of objects to CSV format
   */
  private convertToCSV(data: any[], includeHeaders: boolean = true): string {
    if (!data || data.length === 0) {
      return '';
    }

    const headers = Object.keys(data[0]);
    const csvRows: string[] = [];

    // Add headers if requested
    if (includeHeaders) {
      csvRows.push(headers.join(','));
    }

    // Add data rows
    for (const row of data) {
      const values = headers.map(header => {
        const value = row[header];

        // Handle null/undefined
        if (value === null || value === undefined) {
          return '';
        }

        // Handle dates
        if (value instanceof Date) {
          return value.toISOString();
        }

        // Handle strings that need escaping
        const stringValue = String(value);
        if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
          return `"${stringValue.replace(/"/g, '""')}"`;
        }

        return stringValue;
      });

      csvRows.push(values.join(','));
    }

    return csvRows.join('\n');
  }

  /**
   * Ensures directory exists, creates if needed
   */
  private ensureDirectoryExists(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Validates file path for security
   */
  private validateFilePath(filePath: string): { isValid: boolean; error?: string } {
    if (!filePath || typeof filePath !== 'string') {
      return { isValid: false, error: 'File path must be a non-empty string' };
    }

    // Check for path traversal attempts
    if (filePath.includes('..')) {
      return { isValid: false, error: 'Path traversal not allowed' };
    }

    // Ensure it's a CSV file
    if (!filePath.toLowerCase().endsWith('.csv')) {
      return { isValid: false, error: 'Output file must have .csv extension' };
    }

    // Check path length
    if (filePath.length > 500) {
      return { isValid: false, error: 'File path too long (max 500 characters)' };
    }

    return { isValid: true };
  }

  async run(params: any) {
    try {
      let { query, outputPath, includeHeaders = true } = params;

      // Expand tilde to home directory
      if (outputPath.startsWith('~/')) {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        outputPath = outputPath.replace(/^~/, homeDir);
      }

      // Validate file path
      const pathValidation = this.validateFilePath(outputPath);
      if (!pathValidation.isValid) {
        return {
          success: false,
          message: `File path validation failed: ${pathValidation.error}`,
          error: 'INVALID_FILE_PATH'
        };
      }

      // Use ReadDataTool's validation for SQL security
      const queryValidation = (this.readDataTool as any).validateQuery(query);
      if (!queryValidation.isValid) {
        return {
          success: false,
          message: `Query validation failed: ${queryValidation.error}`,
          error: 'SECURITY_VALIDATION_FAILED'
        };
      }

      console.log(`Executing query for export: ${query.substring(0, 200)}${query.length > 200 ? '...' : ''}`);
      console.log(`Export destination: ${outputPath}`);

      // Execute the query
      const request = new sql.Request();
      const result = await request.query(query);

      if (!result.recordset || result.recordset.length === 0) {
        return {
          success: false,
          message: 'Query returned no results to export',
          error: 'NO_DATA'
        };
      }

      // Convert to CSV
      const csvContent = this.convertToCSV(result.recordset, includeHeaders);

      // Ensure directory exists
      this.ensureDirectoryExists(outputPath);

      // Write to file
      fs.writeFileSync(outputPath, csvContent, 'utf8');

      const fileStats = fs.statSync(outputPath);

      return {
        success: true,
        message: `Successfully exported ${result.recordset.length} rows to ${outputPath}`,
        data: {
          rowCount: result.recordset.length,
          filePath: outputPath,
          fileSize: fileStats.size,
          fileSizeKB: Math.round(fileStats.size / 1024 * 100) / 100
        }
      };

    } catch (error) {
      console.error("Error exporting data:", error);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      return {
        success: false,
        message: `Failed to export data: ${errorMessage}`,
        error: 'EXPORT_FAILED'
      };
    }
  }
}
