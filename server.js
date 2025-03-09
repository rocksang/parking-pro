const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const axios = require('axios');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.static('public'));
app.use(express.json());

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

let locationCache = {};
let reverseCache = {};

// Load caches on startup
(async () => {
    try {
        const data = await fs.readFile('location-cache.json', 'utf8');
        locationCache = JSON.parse(data);
        console.log(`Location cache loaded with ${Object.keys(locationCache).length} locations`);
    } catch (err) {
        console.log('No location cache found, starting fresh:', err.message);
        locationCache = {};
    }
    try {
        const reverseData = await fs.readFile('reverse-cache.json', 'utf8');
        reverseCache = JSON.parse(reverseData);
        console.log(`Reverse cache loaded with ${Object.keys(reverseCache).length} entries`);
    } catch (err) {
        console.log('No reverse cache found, starting fresh:', err.message);
        reverseCache = {};
    }
})();

// Helper functions
const isValidCoordinate = (coord) => typeof coord === 'number' && !isNaN(coord);
const getDistance = (lat1, lng1, lat2, lng2) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLng = (lng2 - lng1) * (Math.PI / 180);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

const saveCache = async (file, data) => {
    try {
        await fs.writeFile(file, JSON.stringify(data, null, 2));
        console.log(`${file} saved`);
    } catch (err) {
        console.error(`Failed to save ${file}:`, err.message);
    }
};

const retryWithBackoff = async (fn, retries = 3, delay = 2000) => {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            console.error(`Attempt ${i + 1}/${retries + 1} failed:`, { message: err.message, code: err.code, response: err.response?.data });
            if (i === retries) throw err;
            await new Promise(res => setTimeout(res, delay * Math.pow(2, i)));
        }
    }
};

const geocodeLocation = async (location, city) => {
    const query = `${location.trim()}, ${city}`.toLowerCase().replace(/\s+/g, ' ');
    console.log('Geocoding:', query);

    if (locationCache[query]) {
        console.log('Using cached coords:', locationCache[query]);
        return locationCache[query];
    }

    try {
        const response = await retryWithBackoff(() => axios.get(NOMINATIM_URL, {
            params: { q: query, format: 'json', limit: 1 },
            headers: { 'User-Agent': 'parking-pro/1.0' },
            timeout: 15000
        }));

        if (response.data[0]) {
            const { lat, lon } = response.data[0];
            const latNum = parseFloat(lat);
            const lngNum = parseFloat(lon);
            if (isValidCoordinate(latNum) && isValidCoordinate(lngNum)) {
                locationCache[query] = { lat: latNum, lng: lngNum };
                await saveCache('location-cache.json', locationCache);
                console.log('Geocoded:', locationCache[query]);
                return locationCache[query];
            }
        }
        console.warn('No valid coords from Nominatim, using fallback');
    } catch (err) {
        console.error('Geocoding failed:', err.message);
    }

    const fallback = { lat: -33.8688, lng: 151.2093 };
    console.log('Using fallback coords:', fallback);
    return fallback;
};

const reverseGeocode = async (lat, lng) => {
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (reverseCache[key]) {
        console.log('Using cached reverse geocode:', reverseCache[key]);
        return reverseCache[key];
    }

    try {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit: 1 req/s
        const response = await axios.get(NOMINATIM_REVERSE_URL, {
            params: { lat, lon: lng, format: 'json' },
            headers: { 'User-Agent': 'parking-pro/1.0' },
            timeout: 15000
        });
        console.log('Reverse geocode response:', response.data);
        const address = response.data.address;
        const street = address?.road || address?.suburb || address?.city || 'Unknown Street';
        reverseCache[key] = street;
        await saveCache('reverse-cache.json', reverseCache);
        return street;
    } catch (err) {
        console.error('Reverse geocode failed:', { message: err.message, code: err.code });
        return 'Unknown Street';
    }
};

const searchParking = async (coords, parkingType) => {
    console.log('Searching parking near:', coords);
    const query = `
        [out:json];
        (
            node["amenity"="parking"](around:2000,${coords.lat},${coords.lng});
            way["amenity"="parking"](around:2000,${coords.lat},${coords.lng});
        );
        out center;
    `;

    try {
        const response = await retryWithBackoff(() => axios.post(OVERPASS_URL, query, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30000
        }), 5, 3000);

        const spotMap = new Map();
        await Promise.all(response.data.elements.slice(0, 10).map(async element => {
            const lat = element.lat || element.center.lat;
            const lng = element.lon || element.center.lon;
            const street = element.tags?.['addr:street'] || element.tags?.highway || await reverseGeocode(lat, lng);
            const distance = getDistance(coords.lat, coords.lng, lat, lng);
            const isFree = element.tags?.access === 'public' || element.tags?.fee === 'no' || !element.tags?.fee;
            const typeMatch = parkingType === 'any' || (parkingType === 'free' ? isFree : !isFree);
            const name = element.tags?.name || (street !== 'Unknown Street' ? `${street} Parking` : 'Unnamed Parking');

            if (distance <= 2 && typeMatch) {
                const spot = {
                    address: name,
                    street: street,
                    latitude: lat,
                    longitude: lng,
                    free: isFree,
                    rules: isFree ? (element.tags?.access === 'public' || element.tags?.fee === 'no' ? 'Free parking' : 'Free parking - verify locally') : 'Paid parking - check signs',
                    distance_km: distance.toFixed(2) // Explicitly included
                };
                if (!spotMap.has(street) || distance < spotMap.get(street).distance_km) {
                    spotMap.set(street, spot);
                }
            }
        }));

        let finalSpots = Array.from(spotMap.values()).sort((a, b) => a.distance_km - b.distance_km);
        if (finalSpots.length === 0 && parkingType === 'free') {
            console.log('No free spots found, returning closest paid options');
            finalSpots = await Promise.all(response.data.elements.slice(0, 3).map(async element => {
                const lat = element.lat || element.center.lat;
                const lng = element.lon || element.center.lon;
                const street = element.tags?.['addr:street'] || element.tags?.highway || await reverseGeocode(lat, lng);
                const distance = getDistance(coords.lat, coords.lng, lat, lng);
                const name = element.tags?.name || (street !== 'Unknown Street' ? `${street} Parking` : 'Unnamed Parking');
                return {
                    address: name,
                    street: street,
                    latitude: lat,
                    longitude: lng,
                    free: false,
                    rules: 'Paid parking - check signs (no free spots nearby)',
                    distance_km: distance.toFixed(2)
                };
            })).sort((a, b) => a.distance_km - b.distance_km);
        }

        console.log('Found spots:', finalSpots);
        return finalSpots;
    } catch (err) {
        console.error('Overpass failed:', { message: err.message, code: err.code });
        console.log('Using fallback spots');
        return [
            {
                address: 'Fallback Parking',
                street: 'Unknown Street',
                latitude: coords.lat,
                longitude: coords.lng,
                free: true,
                rules: 'Free parking (fallback)',
                distance_km: '0.00'
            }
        ];
    }
};

app.post('/parking', async (req, res) => {
    try {
        const { city, location, parkingLength, parkingTime, parkingType, startLocation } = req.body;
        console.log('Received request:', { city, location, parkingLength, parkingTime, parkingType, startLocation });

        if (!city || !location || !parkingType) {
            return res.status(400).json({ error: 'Missing required fields: city, location, parkingType' });
        }

        const [hours, minutes] = (parkingTime || '12:00').split(':').map(Number);
        const timeInHours = hours + (minutes / 60);
        console.log('Parsed time:', timeInHours, 'hours');

        const coords = await geocodeLocation(location, city);
        const parkingSpots = await searchParking(coords, parkingType);

        console.log('Sending response:', { spots: parkingSpots });
        res.json({ spots: parkingSpots });
    } catch (error) {
        console.error('Parking search error:', { message: error.message, stack: error.stack, request: req.body });
        res.status(500).json({ error: 'Failed to fetch parking spots', details: error.message });
    }
});

app.listen(port, () => console.log(`Parking Pro running at http://localhost:${port}`));