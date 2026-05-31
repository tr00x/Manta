import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setConcurrency(4);
// Dark backgrounds compress better with a slightly higher CRF ceiling.
Config.setCodec("h264");
