# My Chrome Extension

This project is a Chrome extension developed using TypeScript. It includes various components that allow interaction with web pages and manage the extension's lifecycle.

## Project Structure

```
my-chrome-extension
├── src
│   ├── background.ts       # Background script for handling events and managing the extension lifecycle
│   ├── content.ts         # Content script for interacting with web pages
│   └── types
│       └── index.ts       # Type definitions and interfaces used in the extension
├── public
│   ├── manifest.json       # Configuration file for the extension
│   └── popup.html          # HTML structure for the extension's popup window
├── package.json            # npm configuration file listing dependencies and scripts
├── tsconfig.json           # TypeScript configuration file specifying compiler options
└── README.md               # Documentation and usage instructions for the project
```

## Installation

To get started with the extension, clone the repository and install the dependencies:

```bash
git clone <repository-url>
cd my-chrome-extension
npm install
```

## Development

To build the TypeScript files, run:

```bash
npm run build
```

To load the extension in Chrome:

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable "Developer mode".
3. Click "Load unpacked" and select the `public` directory of the project.

## Usage

Once the extension is loaded, you can interact with it through the popup window and it will execute the background and content scripts as defined.

## License

This project is licensed under the MIT License.