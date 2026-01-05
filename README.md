# Rent Roll Parser

A web application that extracts structured data from multifamily real estate rent rolls using AI. Upload Excel or PDF rent rolls and get clean, validated JSON data with unit-level details.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

- **Multi-format Support**: Parse both Excel (.xlsx, .xls) and PDF rent rolls
- **AI-Powered Extraction**: Uses Claude AI for intelligent document understanding
- **Validation & Cross-checking**: Compares extracted data against stated totals in documents
- **Interactive Review UI**: Edit extracted data with an Excel-like grid interface
- **Export Options**: Export to JSON or Excel formats
- **Local Storage**: All data stored locally in JSON files

## How It Works

1. **Upload** - Drag and drop or select a rent roll file (Excel or PDF)
2. **Extract** - AI analyzes the document and extracts unit-level data
3. **Validate** - System cross-checks extracted values against stated totals
4. **Review** - Edit any discrepancies in the interactive table
5. **Export** - Download the validated data as JSON or Excel

### Extracted Fields

| Field | Description |
|-------|-------------|
| Unit Number | Unit identifier (e.g., "101", "A-201") |
| Status | Occupied, Vacant, Notice, Model, Down, Applicant |
| Monthly Rent | Primary rent amount |
| Tenant Name | Resident name (if occupied) |
| Unit Type | Floorplan (e.g., "1BR/1BA", "Studio") |
| Square Footage | Unit size |
| Lease Dates | Start/end dates |
| Move-in/out Dates | Tenant move dates |

### Validation Checks

- Unit count verification (stated vs extracted)
- Duplicate unit detection
- Gap detection in sequential unit numbers
- Summary stat comparison (total rent, sqft, occupancy)
- Suspicious pattern flagging

## Prerequisites

- Node.js 20.17+ or 22.9+
- npm or yarn
- [Anthropic API key](https://console.anthropic.com/) for Claude AI

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/rent-roll-parser.git
cd rent-roll-parser
```

2. Install dependencies:
```bash
npm install
```

3. Create environment file:
```bash
cp .env.example .env.local
```

4. Add your Anthropic API key to `.env.local`:
```
ANTHROPIC_API_KEY=your-api-key-here
```

## Usage

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Production

```bash
npm run build
npm start
```

## Project Structure

```
rent-roll-parser/
├── src/
│   ├── app/                    # Next.js app router
│   │   ├── api/               # API routes
│   │   │   ├── upload/        # File upload endpoint
│   │   │   ├── extraction/    # Get/update extractions
│   │   │   └── extractions/   # List extractions
│   │   ├── extraction/[id]/   # Review/edit page
│   │   └── page.tsx           # Upload page
│   ├── components/            # React components
│   │   ├── FileUpload.tsx     # Drag-drop uploader
│   │   ├── ExtractionList.tsx # Previous extractions
│   │   └── AppHeader.tsx      # Navigation header
│   └── lib/
│       ├── parsers/           # Excel & PDF parsing
│       ├── validation/        # Data validation
│       ├── storage.ts         # JSON file storage
│       └── types.ts           # TypeScript interfaces
├── data/
│   └── extractions/           # Stored extraction JSON files
└── public/                    # Static assets
```

## Supported Rent Roll Formats

The parser handles various property management software exports:

- **OneSite / RealPage** - Multi-charge format with status codes
- **ResMan** - Clean tabular format
- **Yardi** - Standard export format
- **Generic Excel** - Column name fuzzy matching

## Tech Stack

- **Framework**: [Next.js 16](https://nextjs.org/) (App Router)
- **UI**: [Mantine v8](https://mantine.dev/)
- **Data Grid**: [AG Grid](https://www.ag-grid.com/)
- **AI**: [Anthropic Claude](https://www.anthropic.com/) (Sonnet 4 / Opus 4.5)
- **Excel Parsing**: [SheetJS](https://sheetjs.com/)
- **Validation**: [Zod](https://zod.dev/)

## API Usage

### Upload File
```bash
curl -X POST http://localhost:3000/api/upload \
  -F "file=@rent-roll.xlsx"
```

### Get Extraction
```bash
curl http://localhost:3000/api/extraction/{id}
```

### List Extractions
```bash
curl http://localhost:3000/api/extractions
```

### Export to Excel
```bash
curl http://localhost:3000/api/extraction/{id}/export -o export.xlsx
```

## Configuration

| Environment Variable | Description | Required |
|---------------------|-------------|----------|
| `ANTHROPIC_API_KEY` | Claude API key for AI extraction | Yes |

## Cost Considerations

PDF parsing uses Claude AI which has associated costs:
- **Claude Sonnet 4**: ~$3/million input tokens, ~$15/million output tokens
- **Claude Opus 4.5**: ~$15/million input tokens, ~$75/million output tokens

A typical rent roll (10-50 pages) costs $0.10-$1.00 to process.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

Built with [Claude Code](https://claude.ai/claude-code) by Anthropic.
