# PattaFlow Frontend

PattaFlow is a state-of-the-art document verification and analysis platform. This frontend provides a premium interface for streaming upload, real-time processing visualization, and detailed validation of EC (Encumbrance Certificate) and Registration Documents.

## ✨ Features

- 🚀 **Real-time Streaming Validation**: Experience live feedback as documents are processed through our extraction and validation engine.
- 🛡️ **Trustability Score**: Instant visual indicators of document authenticity and data consistency.
- 📁 **Flexible Input Methods**:
  - **Local Path**: Process files directly from the server's filesystem for high-speed batch testing.
  - **File Upload**: Intuitive drag-and-drop interface for user-provided PDF and ZIP documents.
- 🗺️ **Integrated Map View**: Geospatial visualization of land parcels and related data.
- 🎨 **Premium UI/UX**: Built with React, Tailwind CSS, and Shadcn UI, featuring a sleek dark-themed aesthetic with smooth animations.

## 🛠️ Project Structure

- `/`: Landing Page - Introduction to PattaFlow.
- `/verify`: Document Verification - The core processing interface.
- `/map`: Geospatial Analysis - Interactive map for land data visualization.

## 🚀 Getting Started

### Prerequisites

- **Node.js** (v18 or later): [Download & Install](https://nodejs.org/)
- **Bun** (Optional, but recommended for speed): [Install Bun](https://bun.sh/)

### Installation

1. Navigate to the project directory:

   ```bash
   cd pattaflow-frontend
   ```

2. Install dependencies:

   ```bash
   # Using npm
   npm install

   # Or using bun
   bun install
   ```

### Running the Application

1. **Start the Backend**: Ensuring the PattaFlow Backend service is running (typically at `http://localhost:8000`).
2. **Start the Frontend**:
   ```bash
   npm run dev
   ```
3. **Internal Access**: Open [http://localhost:5173](http://localhost:5173) in your browser.

## 🧪 Development

- **Linting**: `npm run lint`
- **Testing**: `npm run test`
- **Building**: `npm run build`

---

_Built with ❤️ by the Farmwise Team_
