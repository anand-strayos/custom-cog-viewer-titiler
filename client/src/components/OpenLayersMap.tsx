import { useEffect, useRef, useState, useCallback } from 'react';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import OSM from 'ol/source/OSM';
import XYZ from 'ol/source/XYZ';
import { transformExtent } from 'ol/proj';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

const tile_matrix = 'WebMercatorQuad';
const scale = 1;
const endpoint = "https://titiler.strayos.com"
const data_dir='https://s3strayos.blob.core.windows.net/uploads/dev-anand';
const tile_buffer = 3;

const PRESETS = [
  { label: 'Ortho 1', url: data_dir + '/ortho_cog.tif' },
  { label: 'Large Ortho', url: 'https://s3strayos.blob.core.windows.net/output/airzaar/output/252293/orthophoto/orthophoto_export.tif' },
  { label: 'Larger Ortho', url: 'https://s3strayos.blob.core.windows.net/output/airzaar/output/204540/orthophoto/orthophoto_export.tif' },
];
const HILLSHADE_PARAMS = {
  azimuth: 315,
  angle_altitude: 45,
  buffer: 3,
};

export default function OpenLayersMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const orthoLayerRef = useRef<TileLayer<XYZ> | null>(null);
  const [showOrtho, setShowOrtho] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(true);
  const [selectedOrthoUrl, setSelectedOrthoUrl] = useState(data_dir + '/ortho_cog.tif');
  const [mapReady, setMapReady] = useState(false);
  const orthoUrlRef = useRef(selectedOrthoUrl);
  const layerTypeRef = useRef('ortho');
  const [layerType, setLayerType] = useState('ortho');
  const [validating, setValidating] = useState(false);
  const [isValidCog, setIsValidCog] = useState(false);
  const [validationMessage, setValidationMessage] = useState('');
  const [fetchedMinZoom, setFetchedMinZoom] = useState(0);
  const [fetchedMaxZoom, setFetchedMaxZoom] = useState(24);

  const extraParams: Record<string, string> = {
    dsm_dtm: '&bidx=1&colormap_name=spectral',
    hillshade: `&bidx=1&colormap_name=spectral&algorithm=hillshade&algorithm_params=${encodeURIComponent(JSON.stringify(HILLSHADE_PARAMS))}&buffer=${tile_buffer}&resampling=bilinear&reproject=bilinear`,
    slope: `&bidx=1&colormap_name=spectral&algorithm=slope&buffer=${tile_buffer}&resampling=bilinear&reproject=bilinear`,
  };

  const handleValidate = useCallback(async () => {
    setValidating(true);
    setValidationMessage('');
    setIsValidCog(false);
    try {
      const encodedUrl = encodeURIComponent(selectedOrthoUrl);
      const [validateRes, tilejsonRes] = await Promise.all([
        fetch(`${endpoint}/cog/validate?url=${encodedUrl}`),
        fetch(`${endpoint}/cog/WebMercatorQuad/tilejson.json?url=${encodedUrl}`),
      ]);

      if (!validateRes.ok || !tilejsonRes.ok) {
        setValidationMessage('Failed to validate raster');
        return;
      }

      const validateData = await validateRes.json();
      const tilejsonData = await tilejsonRes.json();

      if (!validateData.COG) {
        setValidationMessage('Raster is not a valid COG');
        return;
      }

      const minZ = validateData.GEO?.MinZoom ?? 0;
      const maxZ = tilejsonData.maxzoom ?? validateData.GEO?.MaxZoom ?? 24;
      setFetchedMinZoom(minZ);
      setFetchedMaxZoom(maxZ);
      setIsValidCog(true);
    } catch {
      setValidationMessage('Failed to validate raster');
    } finally {
      setValidating(false);
    }
  }, [selectedOrthoUrl]);

  const handleConfirmOrtho = useCallback(() => {
    if (!isValidCog) return;
    orthoUrlRef.current = selectedOrthoUrl;
    layerTypeRef.current = layerType;
    setDialogOpen(false);
    setMapReady(true);
  }, [selectedOrthoUrl, layerType, isValidCog]);

  useEffect(() => {
    const container = mapContainer.current;
    if (!mapReady || !container) return;

    const initializeMap = async () => {
      const orthoRasterUrl = orthoUrlRef.current;

      const params = extraParams[layerTypeRef.current] || '';
      const orthoLayer = new TileLayer({
        source: new XYZ({
          url: `${endpoint}/cog/tiles/${tile_matrix}/{z}/{x}/{y}?scale=${scale}&url=${encodeURIComponent(orthoRasterUrl)}${params}`,
        }),
        visible: true,
      });
      orthoLayerRef.current = orthoLayer;

      map.current = new Map({
        target: container,
        layers: [
          new TileLayer({
            source: new OSM(),
          }),
          orthoLayer,
        ],
        view: new View({
          center: [0, 0],
          zoom: fetchedMinZoom,
          minZoom: fetchedMinZoom,
          maxZoom: fetchedMaxZoom,
        }),
      });

      handleCenterMap();
      handleRefreshTiles();

      // Cleanup on unmount
      return () => {
        if (map.current) {
          map.current.setTarget(undefined);
          map.current = null;
        }
      };
    };

    initializeMap();
  }, [mapReady]);

  useEffect(() => {
    if (orthoLayerRef.current) {
      orthoLayerRef.current.setVisible(showOrtho);
    }
  }, [showOrtho]);

  const handleCenterMap = async () => {
    if (!map.current) return;
    try {
      const response = await fetch(
        `${endpoint}/cog/info.geojson?url=${encodeURIComponent(orthoUrlRef.current)}&crs=EPSG%3A4326`
      );
      if (!response.ok) {
        throw new Error('Network response was not ok');
      }
      const data = await response.json();
      if (data.bbox) {
        const extent = transformExtent(data.bbox, 'EPSG:4326', 'EPSG:3857');
        map.current.getView().fit(extent, { padding: [50, 50, 50, 50], duration: 1000 });
      } else {
        console.warn('No bbox found in response');
      }
    } catch (error) {
      console.error('Error fetching bounds:', error);
    }
  };

  const handleRefreshTiles = () => {
    if (!map.current) return;
    
    // Clear cache for all tile layers
    const layers = map.current.getLayers().getArray();
    layers.forEach((layer) => {
      if (layer instanceof TileLayer) {
        const source = layer.getSource();
        if (source && source.clear) {
          source.clear();
        }
      }
    });
    
    // Force redraw of the map
    map.current.render();
  };

  return (
    <>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent showCloseButton={false} onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Select Layer</DialogTitle>
            <DialogDescription>
              Choose the layer type and enter the raster URL to load.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <RadioGroup value={layerType} onValueChange={setLayerType}>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="ortho" id="r-ortho" />
                <Label htmlFor="r-ortho">Orthomosaic</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="dsm_dtm" id="r-dsm-dtm" />
                <Label htmlFor="r-dsm-dtm">DSM / DTM</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="slope" id="r-slope" />
                <Label htmlFor="r-slope">Slope</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="hillshade" id="r-hillshade" />
                <Label htmlFor="r-hillshade">Hillshade</Label>
              </div>
            </RadioGroup>
            <div className="grid gap-2">
              <Label>Quick Select</Label>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => { setSelectedOrthoUrl(p.url); setIsValidCog(false); }}
                    className={`px-3 py-1.5 text-sm rounded-md border transition-colors font-medium ${
                      selectedOrthoUrl === p.url
                        ? 'bg-blue-100 border-blue-500 text-blue-700'
                        : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="layer-url">Or paste raster URL</Label>
              <Input
                  id="layer-url"
                  value={selectedOrthoUrl}
                  onChange={(e) => { setSelectedOrthoUrl(e.target.value); setIsValidCog(false); }}
                  placeholder="https://.../ortho_cog.tif"
                />
            </div>
            {validationMessage && (
              <p className="text-sm text-red-600">{validationMessage}</p>
            )}
            {isValidCog && (
              <p className="text-sm text-green-600">
                Valid COG &mdash; Zoom: {fetchedMinZoom}&ndash;{fetchedMaxZoom}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={handleValidate}
              disabled={validating}
              className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 transition-colors font-medium disabled:opacity-50"
            >
              {validating ? 'Validating...' : 'Validate'}
            </button>
            <button
              onClick={handleConfirmOrtho}
              disabled={!isValidCog}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors font-medium disabled:opacity-50"
            >
              Load Map
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <div className="relative w-full h-screen flex">
      <div className="absolute left-2.5 top-2.5 z-[1000] w-64 bg-white border border-gray-300 rounded-lg shadow-lg p-4">
        {/* <h3 className="text-lg font-semibold text-gray-800 mb-4">Layer Controls</h3> */}
        <div className="mb-4 space-y-2">
          <button
            onClick={handleCenterMap}
            className="w-full px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors font-medium"
          >
            Center to Map
          </button>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">{layerType === 'ortho' ? 'Orthomosaic' : layerType === 'dsm_dtm' ? 'DSM / DTM' : layerType === 'slope' ? 'Slope' : 'Hillshade'}</span>
            <Switch
              checked={showOrtho}
              onCheckedChange={setShowOrtho}
            />
          </div>
        </div>
      </div>
      <div ref={mapContainer} className="flex-1 w-full h-full" />
    </div>
    </>
  );
}