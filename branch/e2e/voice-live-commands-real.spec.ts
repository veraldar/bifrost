import { voiceCommandsSpec } from './voice-commands-check';

/** the way a phone hears it (owner 11-13 r3: "stop" on :8447 did nothing): "Okay, pause." ·
 *  "Continue please." · "Faster please." · a run-on sentence (the reply's own echo) that ENDS in
 *  "stop". Same timeline and expectations as the clean recording. */
voiceCommandsSpec('real speech', 'voice-commands-real.wav');
