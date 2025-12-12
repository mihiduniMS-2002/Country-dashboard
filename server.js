// server.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const NodeCache = require('node-cache');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const OPENAQS_API_KEY = process.env.OPENAQS_API_KEY;
const CACHE_TTL = Number(process.env.CACHE_TTL_SECONDS || 300); // seconds

if (!OPENWEATHER_API_KEY) {
  console.warn('Warning: OPENWEATHER_API_KEY is not set. Weather requests will fail.');
}
if (!OPENAQS_API_KEY) { // <-- NEW CHECK ADDED
  console.warn('Warning: OPENAQS_API_KEY is not set. Air Quality requests will fail.');
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// simple in-memory cache
const cache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: Math.max(60, Math.floor(CACHE_TTL / 2)) });

/**
 * Helper: fetch JSON with timeout, and add OpenAQ API key to headers
 */
async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 10000); // 10s timeout
  
  // NEW CRITICAL LOGIC: Check if the request is for OpenAQ and add the key to headers
  // The V3 API requires the key in the X-API-Key header.
  if (url.includes('api.openaq.org') && OPENAQS_API_KEY) { 
      opts.headers = {
          ...opts.headers,
          'X-API-Key': OPENAQS_API_KEY, // This sends the key in the required header
      };
  }
  
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`HTTP ${resp.status} ${resp.statusText} - ${txt}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(id);
  }

}
function getAqiStatus(pm25Value) {
    if (pm25Value === null || pm25Value === undefined) {
        return "Not Reported";
    }
    // US EPA Standard PM2.5 thresholds (Simplified)
    if (pm25Value <= 12.0) {
        return "Good"; // 0 - 50 AQI
    } else if (pm25Value <= 35.4) {
        return "Moderate"; // 51 - 100 AQI
    } else if (pm25Value <= 55.4) {
        return "Unhealthy for Sensitive Groups"; // 101 - 150 AQI
    } else if (pm25Value <= 150.4) {
        return "Unhealthy"; // 151 - 200 AQI
    } else if (pm25Value <= 250.4) {
        return "Very Unhealthy"; // 201 - 300 AQI
    } else {
        return "Hazardous"; // 301+ AQI
    }
}
/**
 * GET /country-info/:country
 * Returns aggregated data:
 * - country: RestCountries
 * - weather: OpenWeatherMap (current + forecast)
 * - exchange: exchangerate.host (base -> major currencies)
 * - airQuality: OpenAQ
 */
app.get('/country-info/:country', async (req, res) => {
  try {
    const countryRaw = req.params.country;
    if (!countryRaw || countryRaw.trim().length === 0) {
      return res.status(400).json({ error: 'Country name required' });
    }
    const countryName = countryRaw.trim().toLowerCase();
    const cacheKey = `country:${countryName}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json({ fromCache: true, ...cached });
    }

    // 1) RestCountries: get country info (name, capital, population, currency codes, latlng)
    // Using REST Countries v3.1
    const restUrl = `https://restcountries.com/v3.1/name/${encodeURIComponent(countryName)}?fullText=false`; 
    const restData = await fetchJson(restUrl);
    // pick first matching result
    const countryData = Array.isArray(restData) && restData.length > 0 ? restData[0] : null;
    if (!countryData) {
      return res.status(404).json({ error: 'Country not found (RestCountries)' });
    }

    const country = {
      name: countryData.name?.common || countryData.name?.official || countryName,
      officialName: countryData.name?.official,
      capital: Array.isArray(countryData.capital) ? countryData.capital[0] : countryData.capital,
      population: countryData.population,
      region: countryData.region,
      subregion: countryData.subregion,
      flags: countryData.flags,
      latlng: countryData.latlng, // [lat, lon]
      currencies: countryData.currencies // object with currency codes, names
    };

    // 2) OpenWeatherMap: if we have lat/lon, request current weather & basic forecast
    let weather = null;
    try {
      if (country.latlng && country.latlng.length >= 2 && OPENWEATHER_API_KEY) {
        const lat = country.latlng[0];
        const lon = country.latlng[1];
        // Current weather
        const currentUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OPENWEATHER_API_KEY}&units=metric`;
        const current = await fetchJson(currentUrl);

        // 5-day forecast (3-hour steps)
        const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${OPENWEATHER_API_KEY}&units=metric`;
        const forecast = await fetchJson(forecastUrl);

        weather = {
          current: {
            temp: current.main?.temp,
            humidity: current.main?.humidity,
            pressure: current.main?.pressure,
            windSpeed: current.wind?.speed,
            description: current.weather?.[0]?.description,
            icon: current.weather?.[0]?.icon,
            timezone: current.timezone
          },
          forecast: {
            // return first 8 entries (~24 hours) as a sample
            list: Array.isArray(forecast.list) ? forecast.list.slice(0, 8).map(item => ({
              dt: item.dt,
              temp: item.main?.temp,
              description: item.weather?.[0]?.description,
              windSpeed: item.wind?.speed
            })) : []
          }
        };
      } else {
        weather = { error: 'No lat/lon or OpenWeather API key not set' };
      }
    } catch (wErr) {
      weather = { error: String(wErr) };
    }

    // 3) Exchange rates - use exchangerate.host (free, no key). We'll pick the first currency of the country (if exists)
    let exchange = null;
    try {
      const currencyCodes = country.currencies ? Object.keys(country.currencies) : [];
      const base = currencyCodes.length > 0 ? currencyCodes[0] : 'USD';
      // Fetch rates to USD, EUR, GBP
      const symbols = ['USD','EUR','GBP'].join(',');
      const exUrl = `https://api.exchangerate.host/latest?base=${encodeURIComponent(base)}&symbols=${symbols}`;
      const exJson = await fetchJson(exUrl);
      exchange = {
        base,
        rates: exJson && exJson.rates ? exJson.rates : null,
        date: exJson ? exJson.date : null
      };
    } catch (exErr) {
      exchange = { error: String(exErr) };
    }

  // 4) OpenAQ - air quality for major city or country (MIGRATED TO V3 /locations)
let airQuality = null;
try {
    const lat = country.latlng?.[0];
    const lon = country.latlng?.[1];

    if (lat && lon) {
        // V3 endpoint: using coordinates to find nearby LOCATIONS
        // PATH CHANGE: Using /v3/locations instead of /v3/latest to ensure 404 is avoided
         const aqUrl = `https://api.openaq.org/v3/locations?coordinates=${lat},${lon}&radius=25000&limit=5`;
        
        // Note: The X-API-Key logic is correctly handled inside your updated fetchJson helper
        const aqJson = await fetchJson(aqUrl);
        
        // V3 /locations response structure: results array contains location objects, each with a 'latest' property
        airQuality = { 
            // We map the results to extract the latest measurements for the 5 nearest locations
            results: Array.isArray(aqJson.results) ? aqJson.results.map(location => ({
                location: location.id,
                name: location.name,
                // measurements are now extracted from the 'latest' property of the location object
                measurements: location.latest, 
            })) : [] 
        };
    } else {
        airQuality = { error: 'No coordinates available for OpenAQ query.' };
    }

} catch (aqErr) {
    console.error('OpenAQ V3 Error:', aqErr);
    airQuality = { error: String(aqErr) };
}

    // Combined result
    const result = { country, weather, exchange, airQuality, fetchedAt: new Date().toISOString() };

    // Cache
    cache.set(cacheKey, result);

    return res.json({ fromCache: false, ...result });

  } catch (err) {
    console.error('Error /country-info:', err);
    return res.status(500).json({ error: String(err) });
  }
});

// health-check
app.get('/health-check', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// fallback to serve index.html (for SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
