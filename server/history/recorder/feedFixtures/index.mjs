// Every feed group's fixtures, in one list for the tests and the gate.
import { aircraftFixtures } from './aircraft.mjs';
import { hazardFixtures } from './hazards.mjs';

export const FIXTURES = Object.freeze([...aircraftFixtures, ...hazardFixtures]);
