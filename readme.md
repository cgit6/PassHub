# Visitor Management System (VMS)

A full-stack web application designed to manage visitor entries, appointments, and security check-ins for an organization. The system uses QR code scanning and PDF pass generation to streamline the visitor registration process.

## Features

- User authentication and role-based access control (RBAC).
- Visitor registration (Internal by employees or Public via registration page).
- Appointment scheduling and approval workflow.
- Automatic PDF pass generation with embedded QR codes.
- Email and SMS notifications for issued passes.
- Real-time QR code scanning for visitor check-in and check-out.
- Admin dashboard with system-wide statistics and activity logs.
- Security lookup tool to find visitor passes by email.

## Tech Stack

- Frontend: React.js, Tailwind CSS, React Router, Axios.
- Backend: Node.js, Express.js.
- Database: MongoDB (Mongoose).
- Storage: Cloudinary (for PDF and Photo storage).
- Utilities: PDFKit (PDF generation), QRCode (QR generation), Nodemailer (Email), Twilio (SMS).

## User Roles

- Admin: Full system access, user management, system logs, and statistics.
- Employee: Register visitors, create and approve appointments.
- Security: Issue passes for approved appointments, scan QR codes, and lookup visitor passes.
- Visitor: Register themselves, request appointments, and download their passes.

## Installation

### Prerequisites
- Node.js installed.
- MongoDB database (local or Atlas).
- Cloudinary account for file storage.

### Setup Backend
1. Navigate to the backend folder: `cd backend`
2. Install dependencies: `npm install`
3. Create a `.env` file and add the following:
   - PORT=4000
   - MONGO_URI=your_mongodb_connection_string
   - JWT_SECRET=your_secret_key
   - CLOUDINARY_CLOUD_NAME=your_name
   - CLOUDINARY_API_KEY=your_key
   - CLOUDINARY_API_SECRET=your_secret
   - EMAIL_USER=your_email
   - EMAIL_PASS=your_email_password
   - TWILIO_SID=your_sid
   - TWILIO_AUTH_TOKEN=your_token
   - TWILIO_PHONE=your_twilio_number
4. Start the server: `npm start`

### Setup Frontend
1. Navigate to the frontend folder: `cd frontend`
2. Install dependencies: `npm install`
3. Create a `.env` file and add:
   - VITE_API_URL=http://localhost:4000/api
4. Start the development server: `npm run dev`

## Usage
- Access the application at `http://localhost:5173`.
- The first user should be created directly in the database with the role "admin" to start managing the system.
