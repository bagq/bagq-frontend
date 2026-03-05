const map = L.map("map");
map.setView([0, 0], 15);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors"
}).addTo(map);

const marker = L.marker([0, 0]).addTo(map);
marker.bindTooltip(`<img src="new/jeep.png" width="50">`);

// Function to update location
function updateLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const userLat = position.coords.latitude;
                const userLng = position.coords.longitude;

                marker.setLatLng([userLat, userLng]);
                map.setView([userLat, userLng], 15);
            },
            (error) => {
                console.error(`Geolocation error: ${error.message}`);
            },
            {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 5000
            }
        );
    } else {
        console.error("Geolocation is not supported by this browser.");
    }
}

// Initial fetch
updateLocation();

// Update every 30 seconds
setInterval(updateLocation, 30000);
