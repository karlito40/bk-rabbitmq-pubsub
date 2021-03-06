const amqp = require('amqplib');
const backoff = require('backoff');
const EventEmitter = require('events');

class Connection extends EventEmitter {
	constructor (opts) {
		super();
		const { url = 'amqp://guest:guest@localhost:5672/', log, exchangeName, autoCreateExchange = true } =
			opts || {};

		if (!log) {
			throw new Error('need to define log');
		}

		if (!exchangeName) {
			throw new Error('need to define exchangeName');
		}
		this.exchangeName = exchangeName;
		this.log = log;
		this.url = url;

		if (autoCreateExchange) {
			this.createExchange();
		}
	}

	_connection () {
		return new Promise((resolve) => {
			let boff = backoff.exponential({
				randomisationFactor: 0.2,
				initialDelay: 1000,
				maxDelay: 8000
			});

			boff.on('backoff', (number, delay) => {
				this.log.info(`BK-PUBSUB - Connection trial #${number} : waiting for ${delay} ms...'`);
				if (number === 10) {
					this.log.warn('BK-PUBSUB - WARNING: 10 CONNECTION RETRIES');
				} else if (number === 100) {
					this.log.warn('BK-PUBSUB - WARNING: 100 CONNECTION RETRIES');
				}
			});

			boff.on('ready', (number) => {
				this.log.info(`BK-PUBSUB - Connection trial #${number}; connecting...`);
				amqp
					.connect(this.url)
					.then((connection) => {
						connection.on('close', () => {
							this.connectionPromise = null;
							this.getSubscribeChannelPromise = null;
							this.log.info('BK-PUBSUB - Connection closed');
							this.emit('close');
						});
						connection.on('error', (err) => {
							this.log.error(`BK-PUBSUB - Connection error: ${err}`);
							this.emit('error', err);
						});
						this.log.info(`BK-PUBSUB - Connection trial #${number}; connected to ${this.url}`);
						boff.reset();
						return resolve(connection);
					})
					.catch((err) => {
						this.log.error(`BK-PUBSUB - Connection trial #${number}; failed: ${err}`);
						boff.backoff();
					});
			});

			boff.backoff();
		});
	}

	getConnection () {
		if (this.connectionPromise) {
			return this.connectionPromise;
		}

		this.log.info(`BK-PUBSUB - Get connection to ${this.url}`);
		this.connectionPromise = this._connection();
		return this.connectionPromise;
	}

	newChannel () {
		return this.getConnection().then((conn) => conn.createChannel());
	}

	getSubscribeChannel () {
		if (this.getSubscribeChannelPromise) {
			return this.getSubscribeChannelPromise;
		}

		this.getSubscribeChannelPromise = this.newChannel().then((channel) => {
			channel.on('error', (err) => {
				this.log.error(`BK-PUBSUB - Subcribe channel error: ${err}`);
				this.getSubscribeChannelPromise = null;
			});

			return channel;
		});

		return this.getSubscribeChannelPromise;
	}

	createExchange () {
		if (this.createExchangePromise) {
			return this.createExchangePromise;
		}

		return this.createExchangePromise = this.newChannel()
			.then((channel) => {
				this.log.info('BK-PUBSUB - Try to create exchange ' + this.exchangeName);
				return Promise.all([
					channel,
					channel.assertExchange(this.exchangeName, 'topic', {
						durable: true,
						autoDelete: false
					})
				]);
			})
			.then(([channel]) => {
				this.log.info('BK-PUBSUB - Successfuly create exchange ' + this.exchangeName);
				channel.close();
			});
	}
}

module.exports = Connection;
