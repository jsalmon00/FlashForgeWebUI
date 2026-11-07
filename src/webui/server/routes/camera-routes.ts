/**
 * @fileoverview Camera status and proxy configuration routes for the WebUI server.
 *
 * Provides endpoints for camera configuration using go2rtc as the streaming
 * gateway. All camera types (MJPEG and RTSP) are handled through go2rtc, which
 * provides unified WebRTC/MSE/MJPEG fallback for browser playback.
 */

import http from 'http';
import type { Response, Router } from 'express';
import { resolveAndEnsureCameraStream } from '../../../services/CameraStreamCoordinator';
import { getGo2rtcService } from '../../../services/Go2rtcService';
import { getCameraUserConfig, resolveCameraConfig } from '../../../utils/camera-utils';
import { toAppError } from '../../../utils/error.utils';
import type { CameraStatusResponse, StandardAPIResponse } from '../../types/web-api.types';
import type { AuthenticatedRequest } from '../auth-middleware';
import { type RouteDependencies, resolveContext, sendErrorResponse } from './route-helpers';

export function registerCameraRoutes(router: Router, deps: RouteDependencies): void {
  router.get('/camera/status', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const contextResult = resolveContext(req, deps, { requireBackendReady: true });
      if (!contextResult.success) {
        return sendErrorResponse<StandardAPIResponse>(
          res,
          contextResult.statusCode,
          contextResult.error
        );
      }

      const isAvailable = deps.backendManager.isFeatureAvailable(contextResult.contextId, 'camera');
      const go2rtcService = getGo2rtcService();
      const backend = deps.backendManager.getBackendForContext(contextResult.contextId);
      const cameraConfig =
        backend &&
        resolveCameraConfig({
          printerIpAddress: contextResult.context.printerDetails.IPAddress,
          printerFeatures: backend.getBackendStatus().features,
          userConfig: getCameraUserConfig(contextResult.contextId),
        });
      const hasStream =
        !!cameraConfig &&
        cameraConfig.isAvailable &&
        !!cameraConfig.streamUrl &&
        !!cameraConfig.streamType &&
        cameraConfig.sourceType !== 'none' &&
        go2rtcService.hasMatchingStream(
          contextResult.contextId,
          cameraConfig.streamUrl,
          cameraConfig.sourceType,
          cameraConfig.streamType
        );

      const response: CameraStatusResponse = {
        available: isAvailable,
        streaming: hasStream,
        url: isAvailable ? '/api/camera/proxy-config' : undefined,
        clientCount: 0,
      };

      return res.json(response);
    } catch (error) {
      const appError = toAppError(error);
      return sendErrorResponse<StandardAPIResponse>(res, 500, appError.message);
    }
  });

  router.get('/camera/proxy-config', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const contextResult = resolveContext(req, deps, {
        requireBackendReady: true,
        requireBackendInstance: true,
      });
      if (!contextResult.success) {
        return sendErrorResponse<StandardAPIResponse>(
          res,
          contextResult.statusCode,
          contextResult.error
        );
      }

      const { contextId, context, backend } = contextResult;
      if (!backend) {
        return sendErrorResponse<StandardAPIResponse>(res, 503, 'Backend not available');
      }

      const ensuredStream = await resolveAndEnsureCameraStream({
        contextId,
        printerIpAddress: context.printerDetails.IPAddress,
        printerFeatures: backend.getBackendStatus().features,
        userConfig: getCameraUserConfig(contextId),
        go2rtcService: getGo2rtcService(),
      });

      if (!ensuredStream) {
        return sendErrorResponse<StandardAPIResponse>(
          res,
          503,
          'Camera not available for this printer'
        );
      }

      const { cameraConfig, streamConfig } = ensuredStream;

      // Relative WebSocket path served by the WebUI's authenticated camera proxy
      // (CameraStreamProxy). video-rtc resolves it against the page origin, so
      // the browser never connects to the go2rtc port directly.
      const wsUrl = `/api/camera/ws?src=${encodeURIComponent(streamConfig.streamName)}`;

      return res.json({
        success: true,
        wsUrl,
        streamType: cameraConfig.streamType,
        sourceType: cameraConfig.sourceType,
        streamName: streamConfig.streamName,
        apiPort: 3000,
        mjpegUrl: `/api/camera/stream.mjpeg?src=${encodeURIComponent(streamConfig.streamName)}`,
        mode: streamConfig.mode,
        showCameraFps: false,
      });
    } catch (error) {
      const appError = toAppError(error);
      return sendErrorResponse<StandardAPIResponse>(res, 500, appError.message);
    }
  });

  const handleMjpegProxy = (req: AuthenticatedRequest, res: Response) => {
    const src = req.query.src as string;
    if (!src) {
      return res.status(400).send('Missing src query parameter');
    }

    const targetUrl = `http://127.0.0.1:1984/api/stream.mjpeg?src=${encodeURIComponent(src)}`;
    const proxyReq = http.request(targetUrl, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).send(`Camera stream proxy error: ${err.message}`);
      }
    });

    req.on('close', () => {
      proxyReq.destroy();
    });

    proxyReq.end();
  };

  // Support both /api/stream.mjpeg and /api/camera/stream.mjpeg
  router.get('/camera/stream.mjpeg', handleMjpegProxy);
  router.get('/stream.mjpeg', handleMjpegProxy);
}
