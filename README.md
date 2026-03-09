# BAG-Q Jeepney Tracking System

A real-time jeepney tracking application built with Node.js, Express, Socket.IO, and Supabase.

## Features

- Real-time GPS tracking of jeepneys
- Live location updates using Supabase Realtime
- Driver authentication and management
- Passenger view with ETA calculations
- Route visualization using Leaflet maps
- WebSocket support for instant updates

## Tech Stack

**Backend:**
- Node.js
- Express.js
- Socket.IO
- Supabase (PostgreSQL database with real-time subscriptions)

**Frontend:**
- Vanilla JavaScript (ES6 modules)
- Leaflet.js for maps
- Bootstrap 5 for UI
- Supabase Client SDK

## Setup Instructions

### 1. Create Supabase Project

1. Go to [https://supabase.com](https://supabase.com)
2. Create a new project
3. Wait for the database to be provisioned

### 2. Set Up Database Schema

1. Go to your Supabase Dashboard
2. Navigate to **SQL Editor**
3. Copy the contents of `supabase-schema.sql`
4. Paste and run the SQL in the editor
5. This will create all necessary tables, policies, and triggers

### 3. Get Supabase Credentials

1. Go to **Project Settings** > **API**
2. Copy your:
   - Project URL
   - `anon` public key
   - `service_role` key (keep this secret!)

### 4. Configure Environment Variables

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and add your Supabase credentials:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_KEY=your-service-role-key
   PORT=3000
   NODE_ENV=development
   ```

### 5. Update Frontend Configuration

1. Open `config.js`
2. Replace with your Supabase URL and anon key

3. Open `login.html`, `register.html`, and `supabase-client.js`
4. Replace the placeholder values:
   ```javascript
   const SUPABASE_URL = "https://your-project.supabase.co";
   const SUPABASE_ANON_KEY = "your-anon-key-here";
   ```

### 6. Enable Realtime in Supabase

1. Go to **Database** > **Replication**
2. Find the `jeepney_locations` table
3. Enable replication for real-time updates

### 7. Install Dependencies

```bash
npm install
```

### 8. Run the Application

**Development mode (with auto-reload):**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

The server will start on `http://localhost:3000`

## Usage

### For Drivers

1. **Register** as a driver at `/register.html`
   - Select role: "Driver"
   - Fill in jeepney details (plate number, capacity, type)

2. **Login** at `/login.html`
   - You'll be redirected to the driver dashboard

3. **Start Trip**
   - Click "Start Trip" to begin tracking
   - Your location will be updated every 5 seconds
   - Location is saved to Supabase database

4. **End Trip**
   - Click "End Trip" to stop tracking
   - Status changes to "Available"

### For Passengers

1. Open `index.html` (no login required)
2. View all active jeepneys on the map
3. Click on a jeepney marker to see:
   - Plate number
   - Status
   - Estimated Time of Arrival (ETA)
   - Route to destination

## API Endpoints

### Jeepneys
- `GET /api/jeepneys` - Get all active jeepneys
- `GET /api/jeepneys/:plate` - Get jeepney by plate number
- `POST /api/jeepneys` - Register new jeepney
- `PATCH /api/jeepneys/:plate/status` - Update jeepney status

### Locations
- `GET /api/locations` - Get latest locations of all jeepneys
- `POST /api/locations` - Update jeepney location

### Users
- `GET /api/profile/:userId` - Get user profile

### Routes
- `GET /api/routes` - Get all routes

### Health
- `GET /api/health` - Server health check

## Socket.IO Events

### Client → Server
- `driver-connect` - Driver connects with plate info
- `location-update` - Send location update
- `status-update` - Update driver status

### Server → Client
- `jeepney-location` - Broadcast location to all clients
- `jeepney-status` - Broadcast status change

## Database Schema

### Tables

**profiles**
- Extends Supabase auth.users
- Stores user info (username, full_name, role)

**jeepneys**
- Jeepney information
- Links to driver profile
- Stores plate, capacity, type, status

**jeepney_locations**
- Real-time location tracking
- Timestamp-based location history
- Links to jeepney record

**routes**
- Route definitions
- Terminal coordinates

## Project Structure

```
bagq-frontend/
├── server.js                 # Main Node.js server
├── package.json              # Dependencies
├── .env                      # Environment variables (create from .env.example)
├── .env.example              # Environment template
├── supabase-schema.sql       # Database schema
├── config.js                 # Frontend configuration
├── supabase-client.js        # Supabase client service
├── index.html                # Passenger view (map)
├── driver.html               # Driver dashboard
├── login.html                # Login page
├── register.html             # Registration page
└── README.md                 # This file
```

## Security Notes

1. **Never commit** `.env` file to version control
2. Keep your `service_role` key secret
3. The `anon` key is safe to use in frontend
4. Row Level Security (RLS) is enabled on all tables
5. Policies ensure users can only modify their own data

## Troubleshooting

### Realtime not working?
- Check if replication is enabled in Supabase
- Verify your subscription code is correct
- Check browser console for errors

### Location not updating?
- Enable location permissions in browser
- Check if HTTPS is used (required for geolocation)
- Verify Supabase credentials are correct

### Database errors?
- Ensure schema was run successfully
- Check RLS policies are in place
- Verify foreign key relationships

## Future Enhancements

- Push notifications for passengers
- Driver ratings and reviews
- Payment integration
- Multiple routes support
- Admin dashboard
- Analytics and reporting
- Mobile app (React Native)

## License

MIT

## Support

For issues and questions, please open an issue on GitHub.
