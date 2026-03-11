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

// In-memory destination tracking (no DB schema change needed)
const jeepneyDestinations = {};

// In-memory terminal queue system
// Structure: { town: [{ plate_number, driver_name, jeepney_type, seating_capacity, queued_at }], irisan: [...] }
const terminalQueues = { town: [], irisan: [] };

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
    // Only moderators can create accounts
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'Authentication required. Only moderators can create accounts.' });
    }
    const token = authHeader.replace('Bearer ', '');
    const { data: { user: moderator }, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (authErr || !moderator) {
      return res.status(401).json({ success: false, error: 'Invalid session. Please log in again.' });
    }
    if (moderator.user_metadata?.role !== 'moderator') {
      return res.status(403).json({ success: false, error: 'Access denied. Only moderators can create accounts.' });
    }

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
          lat: 16.412996,
          lng: 120.593461
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

    // If driver, get jeepney info from registered plate
    let jeepney = null;
    const plateToUse = meta?.plate_number;
    if (meta?.role === 'driver' && plateToUse) {
      const { data: jeepData } = await supabaseAdmin
        .from('jeepneys')
        .select('*')
        .eq('plate_number', plateToUse)
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

// Get ALL jeepneys (not just on-route) with driver info
app.get('/api/jeepneys/all', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('jeepneys')
      .select('*');

    if (error) throw error;

    // Enrich with driver names from auth users
    const { data: { users } } = await supabaseAdmin.auth.admin.listUsers();
    const driverMap = {};
    users.forEach(u => {
      if (u.user_metadata?.plate_number) {
        driverMap[u.user_metadata.plate_number] = u.user_metadata.full_name || u.user_metadata.username || 'Unknown';
      }
    });

    const enriched = (data || []).map(j => ({
      ...j,
      driver_name: driverMap[j.plate_number] || 'Unknown'
    }));

    res.json({ success: true, data: enriched });
  } catch (error) {
    console.error('Error fetching all jeepneys:', error);
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

// Get all live locations (only for jeepneys currently "On Route")
app.get('/api/locations', async (req, res) => {
  try {
    // Get jeepneys currently On Route with details (source of truth)
    const { data: activeJeepneys, error: jeepError } = await supabaseAdmin
      .from('jeepneys')
      .select('plate_number, jeepney_type, seating_capacity')
      .eq('status', 'On Route');

    if (jeepError) throw jeepError;

    const activePlates = new Set((activeJeepneys || []).map(j => j.plate_number));

    // If no active jeepneys, return empty
    if (activePlates.size === 0) {
      return res.json({ success: true, data: [] });
    }

    const activePlatesArr = Array.from(activePlates);

    // Build a map of jeepney details (type, capacity)
    const jeepDetailMap = {};
    (activeJeepneys || []).forEach(j => {
      jeepDetailMap[j.plate_number] = { jeepney_type: j.jeepney_type, seating_capacity: j.seating_capacity };
    });

    const { data, error } = await supabaseAdmin
      .from('jeepney_locations')
      .select('*')
      .in('plate_number', activePlatesArr)
      .order('timestamp', { ascending: false });

    if (error) throw error;

    // Group by plate_number, get the latest for each, enrich with destination and details
    const latestLocations = {};
    data.forEach(location => {
      if (!latestLocations[location.plate_number]) {
        location.destination = jeepneyDestinations[location.plate_number] || null;
        const details = jeepDetailMap[location.plate_number] || {};
        location.jeepney_type = details.jeepney_type || 'traditional';
        location.seating_capacity = details.seating_capacity || 16;
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
    const { jeepney_id, plate_number, latitude, longitude, status, destination } = req.body;

    if (!plate_number || !latitude || !longitude || !status) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Store destination in memory
    if (destination) {
      jeepneyDestinations[plate_number] = destination;
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
      plate_number, latitude, longitude, status, destination: destination || jeepneyDestinations[plate_number] || null,
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

    // Clear destination when trip ends
    if (status !== 'On Route') {
      delete jeepneyDestinations[plate];
      // Also remove from any terminal queue
      for (const t of ['town', 'irisan']) {
        terminalQueues[t] = terminalQueues[t].filter(j => j.plate_number !== plate);
      }
    }

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

// =============================================
// LIST ALL USERS (moderator only)
// =============================================
app.get('/api/users', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (authErr || !user) {
      return res.status(401).json({ success: false, error: 'Invalid session' });
    }
    if (user.user_metadata?.role !== 'moderator') {
      return res.status(403).json({ success: false, error: 'Access denied. Moderator role required.' });
    }

    const { data: { users } } = await supabaseAdmin.auth.admin.listUsers();
    const userData = users.map(u => ({
      id: u.id,
      email: u.email,
      username: u.user_metadata?.username || '',
      full_name: u.user_metadata?.full_name || '',
      role: u.user_metadata?.role || 'unknown',
      plate_number: u.user_metadata?.plate_number || null,
      created_at: u.created_at
    }));

    res.json({ success: true, data: userData });
  } catch (error) {
    console.error('Error listing users:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// TERMINAL QUEUE MANAGEMENT
// =============================================

// Get terminal queues
app.get('/api/terminal-queue', (req, res) => {
  res.json({ success: true, data: terminalQueues });
});

// Join terminal queue
app.post('/api/terminal-queue', async (req, res) => {
  try {
    const { terminal, plate_number } = req.body;
    if (!terminal || !plate_number) {
      return res.status(400).json({ success: false, error: 'Missing terminal or plate_number' });
    }
    if (!terminalQueues[terminal]) {
      return res.status(400).json({ success: false, error: 'Invalid terminal. Use "town" or "irisan"' });
    }

    // Remove from any existing queue first
    for (const t of ['town', 'irisan']) {
      terminalQueues[t] = terminalQueues[t].filter(j => j.plate_number !== plate_number);
    }

    // Get jeepney details from DB
    const { data: jeepData } = await supabaseAdmin
      .from('jeepneys')
      .select('*')
      .eq('plate_number', plate_number)
      .single();

    // Get driver name
    const { data: { users } } = await supabaseAdmin.auth.admin.listUsers();
    const driver = users.find(u => u.user_metadata?.plate_number === plate_number);
    const driverName = driver?.user_metadata?.full_name || driver?.user_metadata?.username || 'Unknown';

    const queueEntry = {
      plate_number,
      driver_name: driverName,
      jeepney_type: jeepData?.jeepney_type || 'traditional',
      seating_capacity: jeepData?.seating_capacity || 16,
      queued_at: new Date().toISOString()
    };

    terminalQueues[terminal].push(queueEntry);

    // Update jeepney status to Available (at terminal)
    await supabaseAdmin
      .from('jeepneys')
      .update({ status: 'Available' })
      .eq('plate_number', plate_number);

    io.emit('queue-update', { terminal, queues: terminalQueues });

    const position = terminalQueues[terminal].length;
    res.json({ success: true, position, data: terminalQueues });
  } catch (error) {
    console.error('Queue join error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Leave terminal queue
app.delete('/api/terminal-queue/:plate', (req, res) => {
  const plate = req.params.plate;
  for (const t of ['town', 'irisan']) {
    terminalQueues[t] = terminalQueues[t].filter(j => j.plate_number !== plate);
  }
  io.emit('queue-update', { queues: terminalQueues });
  res.json({ success: true, data: terminalQueues });
});

// Dispatcher dispatches a jeepney (remove from queue, set On Route)
app.patch('/api/terminal-queue/:plate/dispatch', async (req, res) => {
  try {
    const plate = req.params.plate;
    const { destination } = req.body;

    // Find which terminal the jeepney is in
    let fromTerminal = null;
    for (const t of ['town', 'irisan']) {
      const idx = terminalQueues[t].findIndex(j => j.plate_number === plate);
      if (idx !== -1) {
        fromTerminal = t;
        terminalQueues[t].splice(idx, 1);
        break;
      }
    }

    if (!fromTerminal) {
      return res.status(404).json({ success: false, error: 'Jeepney not found in any queue' });
    }

    // Set destination (opposite terminal by default)
    const dest = destination || (fromTerminal === 'town' ? 'irisan' : 'town');
    jeepneyDestinations[plate] = dest;

    // Update status to On Route
    await supabaseAdmin
      .from('jeepneys')
      .update({ status: 'On Route' })
      .eq('plate_number', plate);

    io.emit('queue-update', { queues: terminalQueues });
    io.emit('dispatch', { plate_number: plate, from: fromTerminal, destination: dest });

    res.json({ success: true, from: fromTerminal, destination: dest, data: terminalQueues });
  } catch (error) {
    console.error('Dispatch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Dispatcher reorder queue
app.patch('/api/terminal-queue/:terminal/reorder', (req, res) => {
  const { terminal } = req.params;
  const { plate_numbers } = req.body; // ordered array of plate numbers

  if (!terminalQueues[terminal]) {
    return res.status(400).json({ success: false, error: 'Invalid terminal' });
  }

  const currentEntries = {};
  terminalQueues[terminal].forEach(entry => {
    currentEntries[entry.plate_number] = entry;
  });

  const reordered = [];
  plate_numbers.forEach(plate => {
    if (currentEntries[plate]) {
      reordered.push(currentEntries[plate]);
    }
  });

  terminalQueues[terminal] = reordered;
  io.emit('queue-update', { terminal, queues: terminalQueues });
  res.json({ success: true, data: terminalQueues });
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
    console.log('  GET  /api/jeepneys/all');
    console.log('  GET  /api/users');
    console.log('  GET  /api/terminal-queue');
    console.log('  POST /api/terminal-queue');
    console.log('  DELETE /api/terminal-queue/:plate');
    console.log('  PATCH /api/terminal-queue/:plate/dispatch');
    console.log('  PATCH /api/terminal-queue/:terminal/reorder');
    console.log('  GET  /api/routes');
    console.log('===========================================');
  });
}

// Export for Vercel serverless
module.exports = app;
