require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// =============================================
// CONFIGURATION
// =============================================
const app = express();

// Supabase Client (anon key for general queries)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Supabase Admin Client (service role key - bypasses RLS and email rate limits)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// No-op emitter for Vercel (Socket.IO only works locally)
let io = { emit: () => {} };

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// =============================================
// API ROUTES
// =============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// =============================================
// SERVER-SIDE REGISTRATION (bypasses email rate limits)
// =============================================
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, fullName, username, role, plateNumber, seatingCapacity, jeepneyType } = req.body;

    if (!email || !password || !fullName || !username || !role) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Check if username already taken (search existing users)
    const { data: { users: existingUsers } } = await supabaseAdmin.auth.admin.listUsers();
    const usernameTaken = existingUsers.some(u => u.user_metadata?.username === username);
    if (usernameTaken) {
      return res.status(400).json({ success: false, error: 'Username already taken' });
    }

    // Create user via admin API (no email confirmation, no rate limit)
    const metadata = { full_name: fullName, username, role, email };
    if (role === 'driver' && plateNumber) {
      metadata.plate_number = plateNumber;
      metadata.seating_capacity = parseInt(seatingCapacity) || 16;
      metadata.jeepney_type = jeepneyType || 'traditional';
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: metadata
    });

    if (authError) throw authError;

    // If driver, register jeepney in database
    if (role === 'driver' && plateNumber) {
      const jeepId = Date.now();
      const { error: jeepError } = await supabaseAdmin
        .from('jeepneys')
        .insert([{
          id: jeepId,
          plate_number: plateNumber,
          seating_capacity: parseInt(seatingCapacity) || 16,
          jeepney_type: jeepneyType || 'traditional',
          status: 'Available',
          lat: 16.4161384,
          lng: 120.5573176
        }]);

      if (jeepError) {
        console.error('Jeepney registration error:', jeepError);
      } else {
        await supabaseAdmin.auth.admin.updateUserById(authData.user.id, {
          user_metadata: { ...metadata, jeepney_id: jeepId }
        });
      }
    }

    res.json({ success: true, user: authData.user });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// USERNAME → EMAIL LOOKUP (for login by username)
// =============================================
app.get('/api/lookup-email', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, error: 'Username required' });

    const { data: { users } } = await supabaseAdmin.auth.admin.listUsers();
    const user = users.find(u => u.user_metadata?.username === username);

    if (!user) return res.status(404).json({ success: false, error: 'Username not found' });

    res.json({ success: true, email: user.email });
  } catch (error) {
    console.error('Lookup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// SERVER-SIDE LOGIN (returns full user data)
// =============================================
app.post('/api/login', async (req, res) => {
  try {
    const { input, password } = req.body;
    if (!input || !password) return res.status(400).json({ success: false, error: 'Missing credentials' });

    // Resolve email from username if needed
    let email = input;
    if (!input.includes('@')) {
      const { data: { users } } = await supabaseAdmin.auth.admin.listUsers();
      const user = users.find(u => u.user_metadata?.username === input);
      if (!user) return res.status(404).json({ success: false, error: 'Username not found' });
      email = user.email;
    }

    // Sign in
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
    if (error) throw error;

    const meta = data.user.user_metadata;

    // If driver, get jeepney info
    let jeepney = null;
    if (meta?.role === 'driver' && meta?.plate_number) {
      const { data: jeepData } = await supabaseAdmin
        .from('jeepneys')
        .select('*')
        .eq('plate_number', meta.plate_number)
        .single();
      jeepney = jeepData;
    }

    res.json({
      success: true,
      user: data.user,
      session: data.session,
      profile: {
        username: meta?.username,
        full_name: meta?.full_name,
        role: meta?.role,
        email: data.user.email
      },
      jeepney
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all active jeepneys
app.get('/api/jeepneys', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('jeepneys')
      .select('*')
      .eq('status', 'On Route');

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching jeepneys:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get jeepney by plate number
app.get('/api/jeepneys/:plate', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('jeepneys')
      .select('*')
      .eq('plate_number', req.params.plate)
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching jeepney:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all live locations
app.get('/api/locations', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('jeepney_locations')
      .select('*')
      .order('timestamp', { ascending: false });

    if (error) throw error;

    // Group by plate_number and get the latest
    const latestLocations = {};
    data.forEach(location => {
      if (!latestLocations[location.plate_number]) {
        latestLocations[location.plate_number] = location;
      }
    });

    res.json({
      success: true,
      data: Object.values(latestLocations)
    });
  } catch (error) {
    console.error('Error fetching locations:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update jeepney location
app.post('/api/locations', async (req, res) => {
  try {
    const { jeepney_id, plate_number, latitude, longitude, status } = req.body;

    if (!plate_number || !latitude || !longitude || !status) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const locationData = { plate_number, latitude, longitude, status, timestamp: new Date().toISOString() };
    if (jeepney_id) locationData.jeepney_id = jeepney_id;

    const { data, error } = await supabaseAdmin
      .from('jeepney_locations')
      .insert([locationData])
      .select();

    if (error) throw error;

    // Emit to connected clients (local only, no-op on Vercel)
    io.emit('location-update', {
      plate_number, latitude, longitude, status,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update jeepney status
app.patch('/api/jeepneys/:plate/status', async (req, res) => {
  try {
    const { status } = req.body;
    const { plate } = req.params;

    if (!status || !['Available', 'On Route', 'Offline'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status'
      });
    }

    const { data, error } = await supabaseAdmin
      .from('jeepneys')
      .update({ status })
      .eq('plate_number', plate)
      .select();

    if (error) throw error;

    io.emit('status-update', {
      plate_number: plate, status,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Register new jeepney (for drivers)
app.post('/api/jeepneys', async (req, res) => {
  try {
    const { driver_id, plate_number, seating_capacity, jeepney_type } = req.body;

    const { data, error } = await supabaseAdmin
      .from('jeepneys')
      .insert([{
        driver_id,
        plate_number,
        seating_capacity: seating_capacity || 16,
        jeepney_type: jeepney_type || 'traditional',
        status: 'Available'
      }])
      .select();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error registering jeepney:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get user profile
app.get('/api/profile/:userId', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', req.params.userId)
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get routes
app.get('/api/routes', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('routes')
      .select('*');

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching routes:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// LOCAL DEV: Socket.IO + HTTP Server
// =============================================
if (!process.env.VERCEL) {
  const http = require('http');
  const { Server } = require('socket.io');
  const server = http.createServer(app);
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
  });

  let connectedDrivers = {};

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('driver-connect', (data) => {
      connectedDrivers[socket.id] = {
        plate: data.plate,
        driverId: data.driverId,
        timestamp: new Date().toISOString()
      };
      console.log('Driver connected:', data.plate);
    });

    socket.on('location-update', async (data) => {
      try {
        const { plate_number, latitude, longitude, status, jeepney_id } = data;
        const locData = { plate_number, latitude, longitude, status, timestamp: new Date().toISOString() };
        if (jeepney_id) locData.jeepney_id = jeepney_id;
        await supabaseAdmin.from('jeepney_locations').insert([locData]);
        io.emit('jeepney-location', { plate_number, latitude, longitude, status, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error('Error handling location update:', error);
      }
    });

    socket.on('status-update', async (data) => {
      try {
        const { plate_number, status } = data;
        await supabaseAdmin.from('jeepneys').update({ status }).eq('plate_number', plate_number);
        io.emit('jeepney-status', { plate_number, status, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error('Error handling status update:', error);
      }
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
      if (connectedDrivers[socket.id]) {
        console.log('Driver disconnected:', connectedDrivers[socket.id].plate);
        delete connectedDrivers[socket.id];
      }
    });
  });

  // Supabase realtime → Socket.IO bridge
  supabase
    .channel('jeepney_locations_changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'jeepney_locations' },
      (payload) => {
        console.log('New location from Supabase:', payload.new);
        io.emit('jeepney-location', payload.new);
      }
    )
    .subscribe();

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log('===========================================');
    console.log(`BAG-Q Server running on http://localhost:${PORT}`);
    console.log('===========================================');
    console.log('API Endpoints:');
    console.log('  GET  /api/health');
    console.log('  GET  /api/jeepneys');
    console.log('  GET  /api/jeepneys/:plate');
    console.log('  POST /api/jeepneys');
    console.log('  GET  /api/locations');
    console.log('  POST /api/locations');
    console.log('  PATCH /api/jeepneys/:plate/status');
    console.log('  GET  /api/profile/:userId');
    console.log('  GET  /api/routes');
    console.log('===========================================');
  });
}

// Export for Vercel serverless
module.exports = app;
