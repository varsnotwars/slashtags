import { expect } from 'aegir/utils/chai.js'
import { SDK } from '../src/sdk.js'
import b4a from 'b4a'
import c from 'compact-encoding'
import { EventEmitter } from 'events'

const { RELAY_URL, BOOTSTRAP } = process.env
const bootstrap = JSON.parse(BOOTSTRAP)

function sdk (opts = {}) {
  return SDK.init({ bootstrap, relays: [RELAY_URL] })
}

describe('slashtag', () => {
  describe('connection', () => {
    it('should return a connection', async () => {
      const sdkA = await sdk()
      const serverSlashtag = sdkA.slashtag({ name: 'server' })
      await serverSlashtag.listen()

      const sdkB = await sdk()
      const clientSlashtag = sdkB.slashtag({ name: 'client' })

      const connection = await clientSlashtag.connect(serverSlashtag.key)
      expect(connection.remotePublicKey).to.eql(serverSlashtag.key)

      const existingConnection = await clientSlashtag.connect(
        serverSlashtag.key
      )
      expect(existingConnection.remotePublicKey).to.eql(serverSlashtag.key)

      sdkA.close()
      sdkB.close()
    })

    it('should listen, connect and exchange data', async () => {
      const sdkA = await sdk()
      const serverSlashtag = sdkA.slashtag({ name: 'server' })

      const serverGotData = new Promise((resolve) => {
        serverSlashtag.on('connection', (socket, peerInfo) => {
          // eslint-disable-next-line
          socket.on('data', (data) => {
            if (b4a.equals(data, b4a.from('ping'))) {
              socket.write(b4a.from('pong'))
              resolve(true)
            }
          })
        })
      })

      await serverSlashtag.listen()

      const sdkB = await sdk()
      const clientSlashtag = sdkB.slashtag({ name: 'client' })

      const socket = await clientSlashtag.connect(serverSlashtag.key)

      const clientGotData = new Promise((resolve) => {
        socket.on('data', (data) => {
          if (b4a.equals(data, b4a.from('pong'))) {
            resolve(true)
          }
        })
      })

      socket.write(b4a.from('ping'))

      expect(await serverGotData).to.be.true('server got ping')
      expect(await clientGotData).to.be.true('client got pong')

      sdkA.close()
      sdkB.close()
    })

    it('should replicate hypercores over a direct connection', async () => {
      const sdkA = await sdk()
      const alice = sdkA.slashtag({ name: 'alice' })
      await alice.listen()

      const core = await sdkA.store.get({ name: 'foo' })
      await core.ready()

      await core.append([b4a.from('hello'), b4a.from('world')])

      const sdkB = await sdk()
      const bob = sdkB.slashtag({ name: 'alice' })

      const clone = await sdkB.store.get({ key: core.key })
      await clone.ready()

      await clone.update()
      expect(clone.length).to.equal(0)

      await bob.connect(alice.key)
      await clone.update()

      expect(clone.length).to.equal(2)
      expect(await clone.get(0)).to.eql(b4a.from('hello'))
      expect(await clone.get(1)).to.eql(b4a.from('world'))

      sdkA.close()
      sdkB.close()
    })
  })

  describe('protocols', () => {
    it('should register and multiplex multiple protocol over the same connection', async () => {
      class Foo extends EventEmitter {
        constructor (slashtag) {
          super()
          this.slashtag = slashtag
          const self = this
          this.options = {
            protocol: 'foo',
            messages: [
              {
                encoding: c.string,
                onmessage (message) {
                  self.emit('message', message)
                }
              }
            ]
          }
        }

        listen () {
          return this.slashtag.listen()
        }

        async request (publicKey) {
          const connection = await this.slashtag.connect(publicKey)
          const channel = SDK.getChannel(connection, this.options.protocol)
          channel.messages[0].send('foo')
        }
      }

      class Bar extends EventEmitter {
        constructor (slashtag) {
          super()
          this.slashtag = slashtag
          const self = this
          this.options = {
            protocol: 'bar',
            messages: [
              {
                encoding: c.string,
                onmessage (message) {
                  self.emit('message', message)
                }
              }
            ]
          }
        }

        listen () {
          return this.slashtag.listen()
        }

        async request (publicKey) {
          const connection = await this.slashtag.connect(publicKey)
          const channel = SDK.getChannel(connection, this.options.protocol)
          channel.messages[0].send('bar')
        }
      }

      const sdkA = await sdk()
      const alice = sdkA.slashtag({ name: 'alice' })
      const AliceFoo = alice.registerProtocol(Foo)
      const AliceBar = alice.registerProtocol(Bar)

      await AliceFoo.listen()
      await AliceBar.listen()

      const ping = new Promise((resolve) => {
        alice.on('connection', (conn) => {
          conn.on('data', (data) => {
            data = b4a.toString(data)
            if (data === 'ping') resolve(data)
          })
        })
      })

      // ===

      const sdkB = await sdk()
      const bob = sdkB.slashtag({ name: 'bob' })

      const BobFoo = bob.registerProtocol(Foo)
      const BobBar = bob.registerProtocol(Bar)

      const foo = new Promise((resolve) => AliceFoo.on('message', resolve))
      const bar = new Promise((resolve) => AliceBar.on('message', resolve))

      const connection = bob.connect(alice.key)

      const interval = setInterval(async () => {
        (await connection).write(b4a.from('ping'))
      }, 10)

      BobFoo.request(alice.key)
      BobBar.request(alice.key)
      expect(await foo).to.eql('foo')
      expect(await bar).to.eql('bar')
      expect(await ping).to.eql('ping')

      sdkA.close()
      sdkB.close()
      clearInterval(interval)

      await new Promise((resolve) =>
        setTimeout(() => {
          resolve()
        }, 5)
      )
    })
  })

  describe('drive', () => {
    it('should create a slashtag instance with a writable drive', async () => {
      const sdkA = await sdk()

      const slashtag = sdkA.slashtag({
        name: 'drive for bob',
        sdk: sdkA
      })
      await slashtag.ready()

      expect(slashtag.key.length).to.eql(32)
      expect(slashtag.key).to.eql(slashtag.drive.key)

      sdkA.close()
    })

    it('should create a remote read-only slashtag from a url', async () => {
      const sdkA = await sdk()
      const slashtag = sdkA.slashtag({
        name: 'drive for bob',
        sdk: sdkA
      })
      await slashtag.ready()

      const content = b4a.from('hello world')
      await slashtag.drive.write('/foo.txt', content)

      const sdkB = await sdk()
      const clone = sdkB.slashtag({
        url: slashtag.url,
        sdk: sdkB
      })
      await clone.ready()

      expect(clone.key).to.eql(slashtag.key)
      expect(clone.remote).to.eql(true)

      const read = await clone.drive.read('/foo.txt')
      expect(read).to.eql(content)

      sdkA.close()
      sdkB.close()
    })
  })

  describe('profile', () => {
    it('should set and get a profiles', async () => {
      const sdkA = await sdk()
      const alice = sdkA.slashtag({ name: 'alice' })
      await alice.ready()

      const profile = {
        name: 'alice'
      }

      await alice.setProfile(profile)

      expect(await alice.getProfile()).to.eql(profile)

      const sdkB = await sdk()
      const remote = sdkA.slashtag({ url: alice.url })
      await remote.ready()

      expect(await remote.getProfile()).to.eql(profile)

      sdkA.close()
      sdkB.close()
    })
  })
})
