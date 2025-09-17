const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cluster = require('cluster');
const os = require('os');
const Bottleneck = require('bottleneck');
const compression = require('compression');

// Load environment variables from .env file
dotenv.config();

// Get base URL and API key from environment variables
const API_BASE_URL = process.env.API_BASE_URL;
const API_KEY = process.env.API_KEY;
const PORT = process.env.PORT || 3000;

// Cache for storing IP addresses
const ipCache = new Map();

// Use cluster to utilize all CPU cores
if (cluster.isMaster) {
  const numCPUs = os.cpus().length;
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork(); // Fork workers for each CPU core
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork(); // Restart a worker if one dies
  });
} else {
  // Create a proxy server
  const proxy = httpProxy.createProxyServer({
    timeout: 120000, // Increase timeout to 2 minutes
    proxyTimeout: 120000,
  });

  // Create an Express app to manage sessions
  const app = express();

  // Use compression to optimize response sizes
  app.use(compression());

  // Use cookie parser middleware
  app.use(cookieParser());

  // Session configuration
  app.use(session({
    secret: '9c609581-9090-4250-9703-c3932cc31f0f', // Secure secret key
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
  }));

  // Rate limiter to limit the number of concurrent requests
  const limiter = new Bottleneck({
    maxConcurrent: 150,  // Limit concurrent requests
    minTime: 100         // Minimum time between requests (ms)
  });

  // Middleware to redirect the base URL to /phpmyadmin
  app.use((req, res, next) => {
    if (req.path === '/') {
      return res.redirect('/phpmyadmin');
    }
    next();
  });

  // Connection pooling for efficient external API calls
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });

  // Middleware to log session details and fetch target IP
  app.use(async (req, res, next) => {
    const hostname = req.headers.host.split(':')[0]; // Get hostname without port
    const subdomain = hostname.split('.')[0];

    // Check if IP is cached
    if (ipCache.has(subdomain)) {
      req.targetIp = ipCache.get(subdomain);
      return next();
    }

    try {
      // Fetch the IP address from the API
      const response = await axios.get(`${API_BASE_URL}/get-server-ip/${subdomain}`, {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          httpAgent,
          httpsAgent
        }
      });
      console.log('API response:', response.data); // Log API response

      if (response.data.success && response.data.data && response.data.data.ip) {
        req.targetIp = response.data.data.ip;
        ipCache.set(subdomain, req.targetIp); // Cache the IP
        next();
      } else {
        console.error('Invalid API response:', response.data); // Log invalid response
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to get target IP.');
      }
    } catch (error) {
      console.error('API request failed:', error.message); // Log API request error
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Invalid Entry. Please try again.');
    }
  });

  // Route to set session data
  app.get('/set-session/:data', (req, res) => {
    req.session.customData = req.params.data;
    res.send(`Session data set to: ${req.params.data}`);
  });

  // Route to get session data
  app.get('/get-session', (req, res) => {
    res.send(`Session data: ${req.session.customData || 'No data set'}`);
  });


  // Create the server
  const server = http.createServer((req, res) => {
    limiter.schedule(() => {
      app(req, res, () => {
        // If the request is not handled by Express routes, proxy it to the dynamic target IP
        if (req.targetIp) {
          proxy.web(req, res, { target: `http://${req.targetIp}` }, (error) => {
            if (error) {
              console.error('Proxy error:', error.message); // Log proxy error
              res.writeHead(500, { 'Content-Type': 'text/plain' });
              res.end('Proxy error.');
            }
          });
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('No target IP available.');
        }
      });
    });
  });

  // Handle proxy errors
  proxy.on('error', (err, req, res) => {
    console.error('Proxy error:', err.message); // Log proxy error
    res.writeHead(500, {
      'Content-Type': 'text/plain'
    });
    res.end('Proxy error.');
  });

  // Start the server
  server.listen(PORT, () => {
    if (cluster.isWorker) {
      console.log(`Worker ${process.pid} running on port ${PORT}`);
    }
  });
}
