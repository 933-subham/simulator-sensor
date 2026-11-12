/**
 * test/test-hardware-node.js
 * Verification of the ESP32 + PZEM-004T v3.0 hardware telemetry & injection pipeline.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { engine, app } = require('../src/server');

console.log('Testing Hardware Simulation Node Telemetry...');

// 1. Initialize engine
engine.start();

// 2. Test listHardwareNodes
const nodes = engine.listHardwareNodes();
assert(Array.isArray(nodes) && nodes.length > 0, 'Hardware nodes should not be empty');
console.log(`✓ listHardwareNodes returned ${nodes.length} nodes`);

// 3. Inspect a specific node: dev-bldA-pwr-f4
const f4 = nodes.find(n => n.device_id === 'ESP32_HA_F4' || n.deviceId === 'dev-bldA-pwr-f4');
assert(f4, 'ESP32_HA_F4 node must exist');
assert.strictEqual(f4.org_id, 'bput_college', 'org_id should be bput_college');
assert.strictEqual(f4.device_id, 'ESP32_HA_F4', 'device_id should be ESP32_HA_F4');
assert(f4.secret_key && f4.secret_key.startsWith('sk_'), 'secret_key should be generated');
console.log(`✓ Node fields verified: org_id=${f4.org_id}, device_id=${f4.device_id}, secret_key=${f4.secret_key.slice(0, 10)}...`);

// 4. Test live hardware packet
const packet = engine.getDeviceHardwarePacket('dev-bldA-pwr-f4');
assert(packet, 'Packet should not be null');
assert.strictEqual(packet.org_id, 'bput_college');
assert.strictEqual(packet.device_id, 'ESP32_HA_F4');
assert.strictEqual(packet.sensor_id, 'PZEM_004T_HA_F4');
assert(packet.timestamp.includes('+05:30'), 'Timestamp must be IST (+05:30)');
assert(typeof packet.voltage === 'number');
assert(typeof packet.current === 'number');
assert(typeof packet.power === 'number');
assert(typeof packet.energy === 'number');
assert(typeof packet.frequency === 'number');
assert(typeof packet.power_factor === 'number');
assert(packet.signature && packet.signature.length === 64, 'HMAC signature must be 64-char hex');

// Verify signature formula
const expectedDataToSign = `${packet.device_id}|${packet.timestamp}|${packet.voltage.toFixed(1)}|${packet.current.toFixed(3)}|${packet.power.toFixed(1)}|${packet.energy.toFixed(3)}`;
const expectedSig = crypto.createHmac('sha256', f4.secret_key).update(expectedDataToSign).digest('hex');
assert.strictEqual(packet.signature, expectedSig, 'HMAC signature must match cryptographic verification');
console.log('✓ Cryptographic HMAC-SHA256 signature verified matching hardware frame');

// 5. Test Live Injection (14.850A, 230.5V, PF 0.98 -> 3354.2W)
console.log('Testing Live Injection on ESP32_HA_F4...');
const injectedNode = engine.setHardwareInjection('dev-bldA-pwr-f4', {
  voltage: 230.5,
  current: 14.850,
  power_factor: 0.98,
  frequency: 50.0,
  energy: 12.450
});
assert(injectedNode.isInjecting, 'Node must show isInjecting=true');

// Read current packet under injection
const injPacket = engine.getDeviceHardwarePacket('dev-bldA-pwr-f4');
console.log('Injected Packet:', JSON.stringify(injPacket, null, 2));
assert(injPacket.current >= 14.7 && injPacket.current <= 15.0, `Current should be near 14.85A (got ${injPacket.current})`);
assert(injPacket.power >= 3300 && injPacket.power <= 3400, `Power should be near 3354W (got ${injPacket.power})`);

// Verify signature on injected packet
const injDataToSign = `${injPacket.device_id}|${injPacket.timestamp}|${injPacket.voltage.toFixed(1)}|${injPacket.current.toFixed(3)}|${injPacket.power.toFixed(1)}|${injPacket.energy.toFixed(3)}`;
const injSig = crypto.createHmac('sha256', f4.secret_key).update(injDataToSign).digest('hex');
assert.strictEqual(injPacket.signature, injSig, 'Injected packet signature must match');
console.log('✓ Injected packet signature verified matching hardware frame');

// 6. Test Clear Injection
engine.clearHardwareInjection('dev-bldA-pwr-f4');
const clearedNode = engine.getHardwareNode('dev-bldA-pwr-f4');
assert(!clearedNode.isInjecting, 'Node should no longer be injecting');
console.log('✓ Injection reset verified');

// 7. Verify GET /api/devices does not leak secret
const devList = engine.listDevices();
for (const d of devList) {
  assert.strictEqual(d.secret, undefined, 'GET /api/devices must never include secret');
}
console.log('✓ Verified GET /api/devices does not expose secrets');

// 8. Test dynamically adding multiple sensor nodes
console.log('Testing dynamic sensor node provisioning...');
const newNode = engine.addHardwareNode({
  org_id: 'bput_college',
  device_id: 'ESP32_HA_F5',
  sensor_id: 'PZEM_004T_HA_F5',
  label: 'Hostel Block A - Floor 5',
  secret_key: 'sk_bput_ha_f5_custom_secret_key'
});
assert.strictEqual(newNode.device_id, 'ESP32_HA_F5');
assert.strictEqual(newNode.org_id, 'bput_college');
assert.strictEqual(newNode.secret_key, 'sk_bput_ha_f5_custom_secret_key');

const allNodes = engine.listHardwareNodes();
assert(allNodes.some(n => n.device_id === 'ESP32_HA_F5'), 'New node must appear in listHardwareNodes');

const newPacket = engine.getDeviceHardwarePacket('ESP32_HA_F5');
assert.strictEqual(newPacket.device_id, 'ESP32_HA_F5');
assert.strictEqual(newPacket.sensor_id, 'PZEM_004T_HA_F5');
const newExpectedSig = crypto.createHmac('sha256', 'sk_bput_ha_f5_custom_secret_key')
  .update(`${newPacket.device_id}|${newPacket.timestamp}|${newPacket.voltage.toFixed(1)}|${newPacket.current.toFixed(3)}|${newPacket.power.toFixed(1)}|${newPacket.energy.toFixed(3)}`)
  .digest('hex');
assert.strictEqual(newPacket.signature, newExpectedSig, 'New node signature must match');
console.log('✓ Successfully dynamically provisioned additional ESP32 sensor node and verified signature');

// Clean up test node
engine.deleteHardwareNode('ESP32_HA_F5');
assert(!engine.listHardwareNodes().some(n => n.device_id === 'ESP32_HA_F5'), 'Deleted node should not appear');
console.log('✓ Successfully deleted test sensor node');

// 9. Test JSON Sequence Frame Streaming
console.log('Testing JSON Frame Sequence Stream Playback...');
const testDataset = require('../datasets/test_fault_24h.json');
assert(Array.isArray(testDataset) && testDataset.length === 24, 'test_fault_24h.json must have 24 frames');

const streamedNode = engine.startHardwareStream('dev-bldA-pwr-f4', testDataset, { loop: false });
assert(streamedNode.isStreaming, 'Node must show isStreaming=true');
assert.strictEqual(streamedNode.streamStatus.total, 24);

const streamPacket1 = engine.getDeviceHardwarePacket('dev-bldA-pwr-f4');
assert.strictEqual(streamPacket1.device_id, 'ESP32_HA_F4');
assert(streamPacket1.timestamp.includes('+05:30'), 'Stream packet must have fresh live IST timestamp');

const streamSig1 = crypto.createHmac('sha256', f4.secret_key)
  .update(`${streamPacket1.device_id}|${streamPacket1.timestamp}|${streamPacket1.voltage.toFixed(1)}|${streamPacket1.current.toFixed(3)}|${streamPacket1.power.toFixed(1)}|${streamPacket1.energy.toFixed(3)}`)
  .digest('hex');
assert.strictEqual(streamPacket1.signature, streamSig1, 'Streamed frame signature must be cryptographically valid');
console.log('✓ Started JSON stream — verified frame 1 with live IST timestamp and valid HMAC');

// Simulate next tick step
engine.tick();
const statusAfterTick = engine.getHardwareStreamStatus('dev-bldA-pwr-f4');
assert(statusAfterTick.index >= 1, 'Stream index should have advanced');
console.log(`✓ Stream advanced to frame index ${statusAfterTick.index}`);

// Stop stream
engine.stopHardwareStream('dev-bldA-pwr-f4');
const stoppedNode = engine.getHardwareNode('dev-bldA-pwr-f4');
assert(!stoppedNode.isStreaming, 'Node should no longer be streaming');
console.log('✓ Successfully stopped JSON sequence stream');

engine.stop();
console.log('\n🎉 ALL HARDWARE TESTS PASSED PERFECTLY!\n');
process.exit(0);
