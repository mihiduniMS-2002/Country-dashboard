// app.js - front-end logic
const searchBtn = document.getElementById('searchBtn');
const countryInput = document.getElementById('countryInput');
const statusEl = document.getElementById('status');

const countryContent = document.getElementById('countryContent');
const weatherContent = document.getElementById('weatherContent');
const exchangeContent = document.getElementById('exchangeContent');
const aqContent = document.getElementById('aqContent');

searchBtn.addEventListener('click', runSearch);
countryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

function setStatus(text, isError = false) {
  statusEl.textContent = text || '';
  statusEl.style.color = isError ? '#fca5a5' : '';
}

async function runSearch() {
  const q = countryInput.value && countryInput.value.trim();
  if (!q) {
    setStatus('Please enter a country name', true);
    return;
  }
  setStatus('Searching...');
  // reset content
  countryContent.innerHTML = 'Loading...';
  weatherContent.innerHTML = 'Loading...';
  exchangeContent.innerHTML = 'Loading...';
  aqContent.innerHTML = 'Loading...';

  try {
    const resp = await fetch(`/country-info/${encodeURIComponent(q)}`);
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(txt || 'Request failed');
    }
    const json = await resp.json();
    setStatus(json.fromCache ? 'Loaded from cache' : 'Live data loaded');

    renderCountry(json.country);
    renderWeather(json.weather);
    renderExchange(json.exchange);
    renderAQ(json.airQuality);

  } catch (err) {
    console.error(err);
    setStatus('Error fetching data: ' + (err.message || err), true);
    countryContent.innerHTML = '—';
    weatherContent.innerHTML = '—';
    exchangeContent.innerHTML = '—';
    aqContent.innerHTML = '—';
  }
}

function renderCountry(c) {
  if (!c) {
    countryContent.innerHTML = '<p>No country data.</p>';
    return;
  }
  const currencyList = c.currencies ? Object.entries(c.currencies).map(([code, v]) => `<li>${code} — ${v.name} (${v.symbol || ''})</li>`).join('') : '';
  countryContent.innerHTML = `
    <p><strong>${c.name}</strong> ${c.officialName ? `(${c.officialName})` : ''}</p>
    <p>Capital: ${c.capital || '—'}</p>
    <p>Region: ${c.region || '—'} ${c.subregion ? '· ' + c.subregion : ''}</p>
    <p>Population: ${c.population ? c.population.toLocaleString() : '—'}</p>
    <p>Coordinates: ${c.latlng ? c.latlng.join(', ') : '—'}</p>
    ${c.flags ? `<img src="${c.flags.svg || c.flags.png}" alt="flag" style="max-width:120px;margin-top:8px;border-radius:4px;">` : ''}
    <div style="margin-top:8px"><strong>Currencies:</strong><ul>${currencyList}</ul></div>
  `;
}

function renderWeather(w) {
  if (!w) {
    weatherContent.innerHTML = '<p>No weather data.</p>';
    return;
  }
  if (w.error) {
    weatherContent.innerHTML = `<p>Error: ${w.error}</p>`;
    return;
  }
  const cur = w.current;
  const list = w.forecast && w.forecast.list ? w.forecast.list : [];
  weatherContent.innerHTML = `
    <p><strong>Now:</strong> ${cur.description || '—'} — ${cur.temp != null ? cur.temp + ' °C' : '—'}</p>
    <p>Humidity: ${cur.humidity != null ? cur.humidity + '%' : '—'} · Wind: ${cur.windSpeed != null ? cur.windSpeed + ' m/s' : '—'}</p>
    <div style="margin-top:8px"><strong>Short Forecast:</strong>
      <ul>${list.map(it => `<li>${new Date(it.dt*1000).toLocaleString()} — ${it.temp} °C — ${it.description}</li>`).join('')}</ul>
    </div>
  `;
}

function renderExchange(e) {
  if (!e) {
    exchangeContent.innerHTML = '<p>No exchange data.</p>';
    return;
  }
  if (e.error) {
    exchangeContent.innerHTML = `<p>Error: ${e.error}</p>`;
    return;
  }
  const rates = e.rates || {};
  const rows = Object.entries(rates).map(([k,v]) => `<li>1 ${e.base} = ${v} ${k}</li>`).join('');
  exchangeContent.innerHTML = `
    <p>Base currency: <strong>${e.base}</strong> (${e.date || ''})</p>
    <ul>${rows}</ul>
  `;
}

function renderAQ(aq) {
  if (!aq) {
    aqContent.innerHTML = '<p>No air quality data.</p>';
    return;
  }
  if (aq.error) {
    aqContent.innerHTML = `<p>Error: ${aq.error}</p>`;
    return;
  }
  if (!aq.results || aq.results.length === 0) {
    aqContent.innerHTML = '<p>No air quality readings available for this country.</p>';
    return;
  }
  // Show the first few measurement locations
  const rows = aq.results.slice(0,5).map(loc => {
    const measurements = (loc.measurements||[]).map(m => `${m.parameter}: ${m.value} ${m.unit}`).join('; ');
    return `<li><strong>${loc.city || loc.location}</strong> — ${measurements}</li>`;
  }).join('');
  aqContent.innerHTML = `<ul>${rows}</ul>`;
}
