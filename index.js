const axios = require('axios');
const dotenv = require('dotenv');
const schedule = require('node-schedule');
const mailgun = require('mailgun-js');
const haversine = require('haversine-distance');
const https = require('https');
const cheerio = require('cheerio');
const { format, addHours } = require('date-fns');

dotenv.config();

const mg = mailgun({
  apiKey: process.env.MAILGUN_API_KEY,
  domain: process.env.MAILGUN_DOMAIN,
});

const getLaunchTime = () => {
  const now = new Date();
  return format(now, 'yyyyMMdd') + '06';
};

const getEndpoints = () => {
  const now = new Date();
  return [
    { time: '6', label: `Today forecast (${format(now, 'yyyy-MM-dd')})` },
    { time: '30', label: `24 hours forecast (${format(addHours(now, 24), 'yyyy-MM-dd')})` },
    { time: '54', label: `48 hours forecast (${format(addHours(now, 48), 'yyyy-MM-dd')})` },
  ];
};

// Create an Axios instance with disabled SSL verification
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

const getUrl = (time) =>
  `https://weather.uwyo.edu/cgi-bin/balloon_traj?TIME=${getLaunchTime()}&FCST=${time}&POINT=none&LAT=${process.env.LAUNCH_LAT}&LON=${process.env.LAUNCH_LON}&TOP=${process.env.BALLOON_CEILING}&OUTPUT=list&Submit=Submit&.cgifields=POINT&.cgifields=FCST&.cgifields=CALCDROP&.cgifields=TIME&.cgifields=OUTPUT`;

const extractLastRow = (data) => {
  const $ = cheerio.load(data);
  const preBlocks = $('pre');

  if (preBlocks.length >= 2) {
    const secondPreBlock = $(preBlocks[1]).text();
    const rows = secondPreBlock.trim().split('\n');
    const lastRow = rows[rows.length - 1].trim().split(/\s+/);
    console.log("Last row of the second <pre> block:", lastRow);
    
    return {
      lat: parseFloat(lastRow[1]),
      lon: parseFloat(lastRow[2]),
      altitude: parseFloat(lastRow[3]),
    };
  } else {
    console.error("Could not find the second <pre> block in the response.");
    return { lat: NaN, lon: NaN, altitude: NaN };
  }
};

const calculateDistance = (lat1, lon1, lat2, lon2) => {
  return haversine({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 }) / 1000; // in kilometers
};

// Check if the coordinates are over water using isitwater API through RapidAPI
const isWater = async (lat, lon) => {
  try {
    const response = await axios.get('https://isitwater-com.p.rapidapi.com/', {
      params: { latitude: lat, longitude: lon },
      headers: {
        'x-rapidapi-host': process.env.RAPIDAPI_HOST,
        'x-rapidapi-key': process.env.RAPIDAPI_KEY
      }
    });
    const { water } = response.data;
    console.log(`isitwater API Response for (${lat}, ${lon}): ${water ? 'Water' : 'Land'}`);
    return water; // Returns true if the location is water, false if it's land
  } catch (error) {
    console.error('Error fetching water status:', error);
    return false; // Fallback to false (land) if the API request fails
  }
};

// Generate a static map image URL using Mapbox API
const getMapImageUrl = (lat, lon) => {
  const mapboxToken = process.env.MAPBOXAPI_KEY;
  const width = process.env.MAPBOX_IMAGE_WIDTH;
  const height = process.env.MAPBOX_IMAGE_HEIGHT;
  const zoom = process.env.MAPBOX_IMAGE_ZOOM;

  return `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/geojson(%7B%22type%22%3A%22Point%22%2C%22coordinates%22%3A%5B${lon}%2C${lat}%5D%7D)/${lon},${lat},${zoom}/${width}x${height}?access_token=${mapboxToken}`;
};

const sendEmail = (subject, htmlContent) => {
  const data = {
    from: `Weather Balloon Tracker <noreply@${process.env.MAILGUN_DOMAIN}>`,
    to: process.env.NOTIFICATION_EMAILS.split(','),
    subject: subject,
    html: htmlContent
  };
  mg.messages().send(data, (error, body) => {
    if (error) {
      console.log('Error sending email:', error);
    } else {
      console.log('Email sent:', body);
    }
  });
};

const runJob = async () => {
  const endpoints = getEndpoints();
  let results = [];

  for (const endpoint of endpoints) {
    const url = getUrl(endpoint.time);
    console.log('Fetching data from:', url);

    try {
      const response = await axiosInstance.get(url);
      const result = extractLastRow(response.data);

      if (isNaN(result.lat) || isNaN(result.lon)) {
        console.error("Failed to extract valid coordinates from the data.");
        continue;
      }

      const distance = calculateDistance(process.env.BASE_LAT, process.env.BASE_LON, result.lat, result.lon);
      const isInWater = await isWater(result.lat, result.lon); // Use isitwater API to check if it's water
      const isMatching = !isInWater && distance <= parseFloat(process.env.MAX_DISTANCE);

      const mapLink = `https://www.openstreetmap.org/?mlat=${result.lat}&mlon=${result.lon}`;
      const mapImageUrl = getMapImageUrl(result.lat, result.lon);

      results.push({
        time: endpoint.label,
        lat: result.lat,
        lon: result.lon,
        altitude: result.altitude,
        distance: distance.toFixed(2),
        result: isMatching ? 'positive' : 'negative',
        mapLink: mapLink,
        mapImageUrl: mapImageUrl
      });
    } catch (error) {
      console.log('Error fetching data:', error);
    }
  }

  // Prepare the email content
  const matchingResults = results.filter(result => result.result === 'positive');
  const emailSubject = matchingResults.length > 0 ? 'Balloon Prediction - Matching Results' : 'Balloon Predictions Summary';
  let emailContent = '';

  results.forEach(result => {
    emailContent += `
      <h2>${result.time}</h2>
      <p>
        <strong>Coordinates:</strong> ${result.lat}, ${result.lon} 
        (<a href="${result.mapLink}">Map Link</a>)
      </p>
      <p><strong>Distance:</strong> ${result.distance} km</p>
      <p><strong>Altitude:</strong> ${result.altitude} m</p>
      <p><strong>Result:</strong> ${result.result}</p>
      <img src="${result.mapImageUrl}" alt="Map image" />
      <hr/>
    `;
  });

  // Send the email
  sendEmail(emailSubject, emailContent);
};

const testMode = process.env.TEST_MODE === 'true';

if (testMode) {
  console.log('Running in test mode...');
  runJob();
} else {
  console.log('Running in scheduled mode...');

  const scheduleTime = process.env.SCHEDULE_TIME;
  const [hour, minute] = scheduleTime.split(':');

  // Schedule the job using the provided SCHEDULE_TIME in UTC
  schedule.scheduleJob(`${minute} ${hour} * * *`, runJob);
}