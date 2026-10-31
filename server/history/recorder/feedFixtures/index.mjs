// Every feed group's fixtures, in one list for the tests and the gate.
import { aircraftFixtures } from './aircraft.mjs';
import { bikeshareFixtures } from './bikeshare.mjs';
import { hazardFixtures } from './hazards.mjs';
import { transitFixtures } from './transit.mjs';
import { vesselsFixtures } from './vessels.mjs';

export const FIXTURES = Object.freeze([
  ...aircraftFixtures,
  ...bikeshareFixtures,
  ...transitFixtures,
  ...vesselsFixtures,
  ...hazardFixtures,
]);
