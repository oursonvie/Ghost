// If no env is set, default to development
// This needs to be above all other require()
// modules to ensure config gets right setting.

// Module dependencies
var config       = require('./config'),
    express      = require('express'),
    when         = require('when'),
    _            = require('underscore'),
    semver       = require('semver'),
    fs           = require('fs'),
    errors       = require('./errorHandling'),
    plugins      = require('./plugins'),
    path         = require('path'),
    Polyglot     = require('node-polyglot'),
    mailer       = require('./mail'),
    helpers      = require('./helpers'),
    middleware   = require('./middleware'),
    routes       = require('./routes'),
    packageInfo  = require('../../package.json'),
    models        = require('./models'),
    permissions   = require('./permissions'),
    uuid          = require('node-uuid'),
    api           = require('./api'),
    hbs          = require('express-hbs'),

// Variables
    setup,
    init,
    dbHash;

// If we're in development mode, require "when/console/monitor"
// for help in seeing swallowed promise errors, and log any
// stderr messages from bluebird promises.
if (process.env.NODE_ENV === 'development') {
    require('when/monitor/console');
}

function doFirstRun() {
    var firstRunMessage = [
        'Welcome to Ghost.',
        'You\'re running under the <strong>',
        process.env.NODE_ENV,
        '</strong>environment.',

        'Your URL is set to',
        '<strong>' + config().url + '</strong>.',
        'See <a href="http://docs.ghost.org/">http://docs.ghost.org</a> for instructions.'
    ];

    return api.notifications.add({
        type: 'info',
        message: firstRunMessage.join(' '),
        status: 'persistent',
        id: 'ghost-first-run'
    });
}

function initDbHashAndFirstRun() {
    return when(models.Settings.read('dbHash')).then(function (hash) {
        // we already ran this, chill
        // Holds the dbhash (mainly used for cookie secret)
        dbHash = hash.attributes.value;
        return dbHash;
    }).otherwise(function (error) {
        /*jslint unparam:true*/
        // this is where all the "first run" functionality should go
        var hash = uuid.v4();
        return when(models.Settings.add({key: 'dbHash', value: hash, type: 'core'})).then(function () {
            dbHash = hash;
            return dbHash;
        }).then(doFirstRun);
    });
}

// Sets up the express server instance.
// Instantiates the ghost singleton,
// helpers, routes, middleware, and plugins.
// Finally it starts the http server.
function setup(server) {

    // Set up Polygot instance on the require module
    Polyglot.instance = new Polyglot();

    // ### Initialisation
    when.join(
        // Initialise the models
        models.init(),
        // Calculate paths
        config.paths.updatePaths(config().url)
    ).then(function () {
        // Populate any missing default settings
        return models.Settings.populateDefaults();
    }).then(function () {
        // Initialize the settings cache
        return api.init();
    }).then(function () {
        // We must pass the api.settings object
        // into this method due to circular dependencies.
        return config.theme.update(api.settings);
    }).then(function () {
        return when.join(
            // Check for or initialise a dbHash.
            initDbHashAndFirstRun(),
            // Initialize the permissions actions and objects
            permissions.init()
        );
    }).then(function () {
        // Initialise mail after first run,
        // passing in config module to prevent
        // circular dependencies.
        return mailer.init();
    }).then(function () {
        var adminHbs;

        // ##Configuration

        // return the correct mime type for woff filess
        express['static'].mime.define({'application/font-woff': ['woff']});

        // ## View engine
        // set the view engine
        server.set('view engine', 'hbs');

        // Create a hbs instance for admin and init view engine
        adminHbs = hbs.create();
        server.set('admin view engine', adminHbs.express3({partialsDir: config.paths().adminViews + 'partials'}));

        // Load helpers
        helpers.loadCoreHelpers(config, adminHbs);


        // ## Middleware
        middleware(server, dbHash);

        // ## Routing

        // Set up API routes
        routes.api(server);

        // Set up Admin routes
        routes.admin(server);

        // Set up Frontend routes
        routes.frontend(server);

        // Are we using sockets? Custom socket or the default?
        function getSocket() {
            if (config().server.hasOwnProperty('socket')) {
                return _.isString(config().server.socket) ? config().server.socket : path.join(__dirname, '../content/', process.env.NODE_ENV + '.socket');
            }
            return false;
        }

        function startGhost() {
            // Tell users if their node version is not supported, and exit
            if (!semver.satisfies(process.versions.node, packageInfo.engines.node)) {
                console.log(
                    "\nERROR: Unsupported version of Node".red,
                    "\nGhost needs Node version".red,
                    packageInfo.engines.node.yellow,
                    "you are using version".red,
                    process.versions.node.yellow,
                    "\nPlease go to http://nodejs.org to get a supported version".green
                );

                process.exit(0);
            }

            // Startup & Shutdown messages
            if (process.env.NODE_ENV === 'production') {
                console.log(
                    "Ghost is running...".green,
                    "\nYour blog is now available on",
                    config().url,
                    "\nCtrl+C to shut down".grey
                );

                // ensure that Ghost exits correctly on Ctrl+C
                process.on('SIGINT', function () {
                    console.log(
                        "\nGhost has shut down".red,
                        "\nYour blog is now offline"
                    );
                    process.exit(0);
                });
            } else {
                console.log(
                    ("Ghost is running in " + process.env.NODE_ENV + "...").green,
                    "\nListening on",
                    getSocket() || config().server.host + ':' + config().server.port,
                    "\nUrl configured as:",
                    config().url,
                    "\nCtrl+C to shut down".grey
                );
                // ensure that Ghost exits correctly on Ctrl+C
                process.on('SIGINT', function () {
                    console.log(
                        "\nGhost has shutdown".red,
                        "\nGhost was running for",
                        Math.round(process.uptime()),
                        "seconds"
                    );
                    process.exit(0);
                });
            }

        }

        // Initialize plugins then start the server
        plugins.init().then(function () {

            // ## Start Ghost App
            if (getSocket()) {
                // Make sure the socket is gone before trying to create another
                fs.unlink(getSocket(), function (err) {
                    /*jslint unparam:true*/
                    server.listen(
                        getSocket(),
                        startGhost
                    );
                    fs.chmod(getSocket(), '0744');
                });

            } else {
                server.listen(
                    config().server.port,
                    config().server.host,
                    startGhost
                );
            }

        });
    }, function (err) {
        errors.logErrorAndExit(err);
    });
}

// Initializes the ghost application.
function init(app) {
    if (!app) {
        app = express();
    }

    // The server and its dependencies require a populated config
    setup(app);
}

module.exports = init;
