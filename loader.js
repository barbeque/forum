'use strict';

var	nconf = require('nconf'),
	fs = require('fs'),
	url = require('url'),
	path = require('path'),
	fork = require('child_process').fork,

	async = require('async'),
	logrotate = require('logrotate-stream'),
	file = require('./src/file'),
	pkg = require('./package.json');

nconf.argv().env().file({
	file: path.join(__dirname, '/config.json')
});

var	pidFilePath = __dirname + '/pidfile',
	output = logrotate({ file: __dirname + '/logs/output.log', size: '1m', keep: 3, compress: true }),
	silent = nconf.get('silent') === 'false' ? false : nconf.get('silent') !== false,
	numProcs,
	workers = [],

	Loader = {
		timesStarted: 0
	};

Loader.init = function (callback) {
	if (silent) {
		console.log = function () {
			var args = Array.prototype.slice.call(arguments);
			output.write(args.join(' ') + '\n');
		};
	}

	process.on('SIGHUP', Loader.restart);
	process.on('SIGUSR2', Loader.reload);
	process.on('SIGTERM', Loader.stop);
	callback();
};

Loader.displayStartupMessages = function (callback) {
	console.log('');
	console.log('NodeBB v' + pkg.version + ' Copyright (C) 2013-2014 NodeBB Inc.');
	console.log('This program comes with ABSOLUTELY NO WARRANTY.');
	console.log('This is free software, and you are welcome to redistribute it under certain conditions.');
	console.log('For the full license, please visit: http://www.gnu.org/copyleft/gpl.html');
	console.log('');
	callback();
};

Loader.addWorkerEvents = function (worker) {

	worker.on('exit', function (code, signal) {
		if (code !== 0) {
			if (Loader.timesStarted < numProcs * 3) {
				Loader.timesStarted++;
				if (Loader.crashTimer) {
					clearTimeout(Loader.crashTimer);
				}
				Loader.crashTimer = setTimeout(function () {
					Loader.timesStarted = 0;
				}, 10000);
			} else {
				console.log(numProcs * 3 + ' restarts in 10 seconds, most likely an error on startup. Halting.');
				process.exit();
			}
		}

		console.log('[cluster] Child Process (' + worker.pid + ') has exited (code: ' + code + ', signal: ' + signal + ')');
		if (!(worker.suicide || code === 0)) {
			console.log('[cluster] Spinning up another process...');

			forkWorker(worker.index, worker.isPrimary);
		}
	});

	worker.on('message', function (message) {
		if (message && typeof message === 'object' && message.action) {
			switch (message.action) {
				case 'restart':
					console.log('[cluster] Restarting...');
					Loader.restart();
				break;
				case 'reload':
					console.log('[cluster] Reloading...');
					Loader.reload();
				break;
			}
		}
	});
};

Loader.start = function (callback) {
	numProcs = getPorts().length;
	console.log('Clustering enabled: Spinning up ' + numProcs + ' process(es).\n');

	for (var x = 0; x < numProcs; ++x) {
		forkWorker(x, x === 0);
	}

	if (callback) {
		callback();
	}
};

function forkWorker(index, isPrimary) {
	var ports = getPorts();
	var args = [];

	if(!ports[index]) {
		return console.log('[cluster] invalid port for worker : ' + index + ' ports: ' + ports.length);
	}

	process.env.isPrimary = isPrimary;
	process.env.isCluster = ports.length > 1 ? true : false;
	process.env.port = ports[index];

	var worker = fork('app.js', args, {
		silent: silent,
		env: process.env
	});

	worker.index = index;
	worker.isPrimary = isPrimary;

	workers[index] = worker;

	Loader.addWorkerEvents(worker);

	if (silent) {
		var output = logrotate({ file: __dirname + '/logs/output.log', size: '1m', keep: 3, compress: true });
		worker.stdout.pipe(output);
		worker.stderr.pipe(output);
	}
}

function getPorts() {
	var _url = nconf.get('url');
	if (!_url) {
		console.log('[cluster] url is undefined, please check your config.json');
		process.exit();
	}
	var urlObject = url.parse(_url);
	var port = nconf.get('port') || nconf.get('PORT') || urlObject.port || 4567;
	if (!Array.isArray(port)) {
		port = [port];
	}
	return port;
}

Loader.restart = function () {
	killWorkers();

	var pathToConfig = path.join(__dirname, '/config.json');
	nconf.remove('file');
	nconf.use('file', { file: pathToConfig });

	fs.readFile(pathToConfig, {encoding: 'utf-8'}, function (err, configFile) {
		if (err) {
			console.log('Error reading config : ' + err.message);
			process.exit();
		}

		var conf = JSON.parse(configFile);

		nconf.stores.env.readOnly = false;
		nconf.set('url', conf.url);
		nconf.stores.env.readOnly = true;

		Loader.start();
	});
};

Loader.reload = function () {
	workers.forEach(function (worker) {
		worker.send({
			action: 'reload'
		});
	});
};

Loader.stop = function () {
	killWorkers();

	// Clean up the pidfile
	fs.unlinkSync(__dirname + '/pidfile');
};

function killWorkers() {
	workers.forEach(function (worker) {
		worker.suicide = true;
		worker.kill();
	});
}

Loader.notifyWorkers = function (msg, worker_pid) {
	worker_pid = parseInt(worker_pid, 10);
	workers.forEach(function (worker) {
		if (parseInt(worker.pid, 10) !== worker_pid) {
			try {
				worker.send(msg);
			} catch (e) {
				console.log('[cluster/notifyWorkers] Failed to reach pid ' + worker_pid);
			}
		}
	});
};

fs.open(path.join(__dirname, 'config.json'), 'r', function (err) {
	if (!err) {
		if (nconf.get('daemon') !== 'false' && nconf.get('daemon') !== false) {
			if (file.existsSync(pidFilePath)) {
				try {
					var	pid = fs.readFileSync(pidFilePath, { encoding: 'utf-8' });
					process.kill(pid, 0);
					process.exit();
				} catch (e) {
					fs.unlinkSync(pidFilePath);
				}
			}

			require('daemon')({
				stdout: process.stdout,
				stderr: process.stderr
			});

			fs.writeFile(__dirname + '/pidfile', process.pid);
		}

		async.series([
			Loader.init,
			Loader.displayStartupMessages,
			Loader.start
		], function (err) {
			if (err) {
				console.log('[loader] Error during startup: ' + err.message);
			}
		});
	} else {
		// No config detected, kickstart web installer
		var child = require('child_process').fork('app');
	}
});
