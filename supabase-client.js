// =============================================
// SUPABASE CLIENT SERVICE
// =============================================
// This file provides a centralized Supabase client
// and helper functions for the frontend

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

// Supabase Configuration
const SUPABASE_URL = "https://jiypktabinncpbhoulte.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppeXBrdGFiaW5uY3BiaG91bHRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MTA4NjgsImV4cCI6MjA4ODI4Njg2OH0.Pty4CL9Tfw5afYhQ0JfOrF2UyYj4JYyRBLrndk0cTvk";

// Create Supabase client
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// =============================================
// AUTHENTICATION HELPERS
// =============================================

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (!error) {
    localStorage.clear();
    window.location.href = "login.html";
  }
  return error;
}

export async function getEmailByUsername(username) {
  const { data, error } = await supabase
    .from('profiles')
    .select('email')
    .eq('username', username)
    .single();

  if (error) return { email: null, error };
  return { email: data.email, error: null };
}

// =============================================
// LOCATION TRACKING
// =============================================

export async function updateLocation(jeepneyId, plateNumber, latitude, longitude, status) {
  // jeepney_id is optional (nullable in DB)
  const locationData = {
    plate_number: plateNumber,
    latitude,
    longitude,
    status,
    timestamp: new Date().toISOString()
  };
  if (jeepneyId) locationData.jeepney_id = jeepneyId;

  const { data, error } = await supabase
    .from('jeepney_locations')
    .insert([locationData]);

  return { data, error };
}

export async function getActiveJeepneys() {
  const { data, error } = await supabase
    .from('jeepneys')
    .select(`
      *,
      profiles:driver_id (username, full_name)
    `)
    .in('status', ['On Route', 'Available']);

  return { data, error };
}

export async function getLatestLocations() {
  const { data, error } = await supabase
    .from('jeepney_locations')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(100);

  if (error) return { data: null, error };

  // Group by plate_number and get the latest
  const latestLocations = {};
  data.forEach(location => {
    if (!latestLocations[location.plate_number] && location.status === "On Route") {
      latestLocations[location.plate_number] = location;
    }
  });

  return { data: Object.values(latestLocations), error: null };
}

// =============================================
// JEEPNEY MANAGEMENT
// =============================================

export async function updateJeepneyStatus(plateNumber, status) {
  const { data, error } = await supabase
    .from('jeepneys')
    .update({ status })
    .eq('plate_number', plateNumber)
    .select();

  return { data, error };
}

export async function getJeepneyByPlate(plateNumber) {
  const { data, error } = await supabase
    .from('jeepneys')
    .select('*')
    .eq('plate_number', plateNumber)
    .single();

  return { data, error };
}

// =============================================
// REAL-TIME SUBSCRIPTIONS
// =============================================

export function subscribeToLocations(callback) {
  const channel = supabase
    .channel('jeepney_locations_realtime')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'jeepney_locations'
      },
      (payload) => {
        callback(payload.new);
      }
    )
    .subscribe();

  return channel;
}

export function subscribeToJeepneyStatus(callback) {
  const channel = supabase
    .channel('jeepneys_status_realtime')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'jeepneys'
      },
      (payload) => {
        callback(payload.new);
      }
    )
    .subscribe();

  return channel;
}

// =============================================
// PROFILE HELPERS
// =============================================

export async function getUserProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  return { data, error };
}
