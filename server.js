require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const DATA_DIR = path.join(__dirname, 'data', 'nasa');
const CSV_PATH = path.join(DATA_DIR, 'basin_flood_summary.csv');
const GEOJSON_PATH = path.join(DATA_DIR, 'basins.geojson');
const MAP_PATH = path.join(DATA_DIR, 'event_flood_map.png');
const CLASSES_PATH = path.join(DATA_DIR, 'event_flood_classes.tif');
const INDEX_PATH = path.join(__dirname, 'index.html');

const BASINS = {
    babahoyo: {
        en: 'Babahoyo Basin',
        ar: 'حوض نهر باباهويو',
        aliases: ['babahoyo']
    },
    lower_guayas: {
        en: 'Lower Guayas Basin',
        ar: 'حوض غواياس السفلي',
        aliases: ['lower guayas', 'lower_guayas']
    },
    daule: {
        en: 'Daule Basin',
        ar: 'حوض نهر داولي',
        aliases: ['daule']
    },
    vinces: {
        en: 'Vinces Basin',
        ar: 'حوض نهر فينسيس',
        aliases: ['vinces']
    }
};

function parseCSVLine(line) {
    const values = [];
    let value = '';
    let quoted = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];

        if (ch === '"') {
            if (quoted && line[i + 1] === '"') {
                value += '"';
                i++;
            } else {
                quoted = !quoted;
            }
        } else if (ch === ',' && !quoted) {
            values.push(value.trim());
            value = '';
        } else {
            value += ch;
        }
    }

    values.push(value.trim());
    return values;
}

function normalize(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function numberOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function loadNASAResults() {
    if (!fs.existsSync(CSV_PATH)) return [];

    const content = fs.readFileSync(CSV_PATH, 'utf8').replace(/^\uFEFF/, '');
    const lines = content.split(/\r?\n/).filter(line => line.trim());

    if (lines.length < 2) return [];

    const headers = parseCSVLine(lines[0]);

    return lines.slice(1).map(line => {
        const values = parseCSVLine(line);
        const row = {};

        headers.forEach((header, index) => {
            row[header.trim()] = values[index] ?? '';
        });

        return row;
    });
}

function findBasinRow(rows, basinId) {
    const basin = BASINS[basinId];
    if (!basin) return null;

    return rows.find(row => {
        const name = normalize(row.basin);
        return basin.aliases.some(alias => name === normalize(alias));
    }) || null;
}

function getMetric(row, key) {
    return row ? numberOrNull(row[key]) : null;
}

function getMetadata() {
    return {
        satellite: 'NASA NISAR',
        product: 'Level-2 GCOV',
        eventGranule: 'NISAR_L2_PR_GCOV_034_112_D_089_4005_DHDH_A_20261031T233908_20261031T233945_P05036_N_F_J_001',
        baselineSearchWindow: {
            start: '2026-06-01',
            end: '2026-10-15'
        },
        thresholds: {
            waterDb: -18.0,
            floodedVegetationChangeDb: 3.0,
            vegetationHvDb: -20.0
        },
        processingStep: 8,
        classificationStatus: 'provisional threshold estimate',
        limitations: [
            'Threshold-based classification has not been field validated.',
            'Flooded vegetation is a proxy, not confirmed flooding.',
            'Flood percentage is classified area divided by valid scene area, not flood probability.',
            'Scene coverage differs between basins.',
            'Elevation, slope and approximate HAND are derived from Copernicus DEM.',
            'HAND is approximate and is not hydrologically conditioned.',
            'Lower Guayas is a cumulative downstream catchment and overlaps upstream drainage.'
        ]
    };
}

app.get('/', (req, res) => {
    res.sendFile(INDEX_PATH);
});

app.get('/api/health', (req, res) => {
    try {
        const rows = loadNASAResults();

        res.json({
            status: 'ok',
            project: 'HydroVision',
            dataSource: 'NASA NISAR GCOV analysis CSV',
            nasaCsvPresent: fs.existsSync(CSV_PATH),
            nasaResultsLoaded: rows.length,
            geojsonPresent: fs.existsSync(GEOJSON_PATH),
            floodMapPresent: fs.existsSync(MAP_PATH),
            classificationRasterPresent: fs.existsSync(CLASSES_PATH),
            expectedFile: 'data/nasa/basin_flood_summary.csv',
            basins: Object.keys(BASINS),
            datasetStatus: rows.length === 4 ? 'four basin records loaded' : 'incomplete dataset'
        });
    } catch (error) {
        console.error('Health error:', error);
        res.status(500).json({
            status: 'error',
            message: 'Unable to read NASA results'
        });
    }
});

app.get('/api/basins', (req, res) => {
    res.json(BASINS);
});

app.get('/api/basins/geojson', (req, res) => {
    if (!fs.existsSync(GEOJSON_PATH)) {
        return res.status(404).json({ error: 'Basin GeoJSON not found' });
    }

    res.sendFile(GEOJSON_PATH);
});

app.get('/api/outputs/map', (req, res) => {
    if (!fs.existsSync(MAP_PATH)) {
        return res.status(404).json({ error: 'Flood map not found' });
    }

    res.sendFile(MAP_PATH);
});

app.get('/api/outputs/classes', (req, res) => {
    if (!fs.existsSync(CLASSES_PATH)) {
        return res.status(404).json({ error: 'Classification raster not found' });
    }

    res.download(CLASSES_PATH, 'event_flood_classes.tif');
});

app.post('/api/analyze', (req, res) => {
    try {
        const {
            basinId = 'babahoyo',
            role = 'farmer',
            lang = 'ar'
        } = req.body || {};

        if (!BASINS[basinId]) {
            return res.status(400).json({ error: 'Invalid basin ID' });
        }

        if (!['farmer', 'tourist', 'resident'].includes(role)) {
            return res.status(400).json({ error: 'Invalid user role' });
        }

        const language = lang === 'en' ? 'en' : 'ar';
        const rows = loadNASAResults();
        const row = findBasinRow(rows, basinId);
        const basin = BASINS[basinId];

        const recommendations = {
            farmer: {
                ar: [
                    'راجع نتائج رصد المياه قبل اتخاذ قرارات تخص الأراضي الزراعية.',
                    'تابع التحذيرات الرسمية والظروف الجوية المحلية.',
                    'لا تعتبر نتائج الرصد الفضائي بديلاً عن القياسات الميدانية.'
                ],
                en: [
                    'Review observed water results before making agricultural decisions.',
                    'Follow official alerts and local weather conditions.',
                    'Satellite observations do not replace field measurements.'
                ]
            },
            tourist: {
                ar: [
                    'راجع التحذيرات الرسمية قبل زيارة المناطق القريبة من الأنهار.',
                    'تجنب المناطق المنخفضة عند صدور تحذيرات محلية.',
                    'لا تعتمد على خريطة الرصد الفضائي وحدها لتحديد سلامة الطرق.'
                ],
                en: [
                    'Check official alerts before visiting river-adjacent areas.',
                    'Avoid low-lying areas when local warnings are issued.',
                    'Do not use satellite maps alone to determine road safety.'
                ]
            },
            resident: {
                ar: [
                    'تابع تعليمات الجهات المحلية المختصة.',
                    'تحقق من حالة الطرق والمناطق المنخفضة من مصادر محلية موثوقة.',
                    'استخدم بيانات الأقمار الصناعية كمصدر دعم وليس كإنذار رسمي.'
                ],
                en: [
                    'Follow instructions from local authorities.',
                    'Check road and low-lying area conditions through trusted local sources.',
                    'Use satellite observations as supporting information, not an official warning.'
                ]
            }
        };

        const metrics = {
            new_open_water_km2: getMetric(row, 'new_open_water_km2'),
            permanent_water_km2: getMetric(row, 'permanent_water_km2'),
            flooded_veg_km2: getMetric(row, 'flooded_vegetation_proxy_km2'),
            flooded_percent: getMetric(row, 'new_flood_pct_of_valid_scene_area'),
            new_flood_total_km2: getMetric(row, 'new_flood_total_km2'),
            mean_slope_deg: getMetric(row, 'mean_slope_deg'),
            mean_elev_m: getMetric(row, 'mean_elevation_m'),
            flooded_mean_HAND_m: getMetric(row, 'mean_flood_HAND_approx_m'),
            mean_HV_dB_base: getMetric(row, 'mean_baseline_HV_dB'),
            area_km2: getMetric(row, 'basin_area_km2'),
            scene_valid_km2: getMetric(row, 'scene_valid_km2'),
            scene_coverage_pct: getMetric(row, 'scene_coverage_pct')
        };

        res.json({
            basinId,
            basinName: basin[language],
            dataAvailable: Boolean(row),
            source: row ? 'nasa-nisar-gcov' : 'awaiting-nasa-csv',
            story: row
                ? (language === 'ar'
                    ? 'تعرض هذه الصفحة نتائج تصنيف أولي لبيانات NASA NISAR GCOV للحدث المحدد. النسب المعروضة تمثل مساحة مصنفة من مساحة المشهد الصالحة للتحليل، وليست احتمالًا للفيضان أو إنذارًا رسميًا.'
                    : 'This page presents a provisional classification of NASA NISAR GCOV data for the selected event. Percentages represent classified area relative to valid scene area, not flood probability or an official warning.')
                : (language === 'ar'
                    ? 'لا تتوفر نتائج لهذا الحوض في ملف NASA الحالي.'
                    : 'No results are available for this basin in the current NASA file.'),
            metrics,
            metadata: getMetadata(),
            recommendations: recommendations[role][language],
            recommendationType: 'general safety guidance, not AI-generated'
        });

    } catch (error) {
        console.error('Analysis error:', error);
        res.status(500).json({ error: 'Unable to analyze NASA results' });
    }
});

app.post('/api/government', (req, res) => {
    const { season = 'flood', lang = 'ar' } = req.body || {};
    const language = lang === 'en' ? 'en' : 'ar';

    const strategies = {
        flood: [
            {
                basin: ['حوض نهر باباهويو', 'Babahoyo Basin'],
                title: ['دراسة مسارات الجريان السطحي', 'Runoff Pathway Assessment'],
                impact: ['مقترح تخطيطي', 'Planning Proposal'],
                desc: [
                    'دراسة مناطق تجمع المياه ونتائج رصد المياه الجديدة لدعم التخطيط المحلي.',
                    'Study water accumulation areas and new-water observations to support local planning.'
                ]
            },
            {
                basin: ['حوض غواياس السفلي', 'Lower Guayas Basin'],
                title: ['دراسة تأثير المياه الساحلية', 'Coastal Water Assessment'],
                impact: ['مقترح تخطيطي', 'Planning Proposal'],
                desc: [
                    'مقارنة نتائج الرصد الفضائي مع بيانات المد والجزر والقياسات المحلية.',
                    'Compare satellite observations with tide data and local measurements.'
                ]
            },
            {
                basin: ['حوض داولي', 'Daule Basin'],
                title: ['متابعة تغيرات المسطحات المائية', 'Water Extent Monitoring'],
                impact: ['مقترح تخطيطي', 'Planning Proposal'],
                desc: [
                    'استخدام نتائج الرصد لدعم تقييم تغير المسطحات المائية حول المناطق الزراعية.',
                    'Use observations to support assessment of water extent changes near agricultural areas.'
                ]
            },
            {
                basin: ['حوض فينسيس', 'Vinces Basin'],
                title: ['تقييم تعرض الأراضي المنخفضة', 'Lowland Exposure Assessment'],
                impact: ['مقترح تخطيطي', 'Planning Proposal'],
                desc: [
                    'مقارنة مناطق المياه الجديدة والغطاء النباتي المتأثر مع بيانات الارتفاع.',
                    'Compare new-water and affected-vegetation areas with elevation data.'
                ]
            }
        ],
        drought: [
            {
                basin: ['حوض نهر باباهويو', 'Babahoyo Basin'],
                title: ['متابعة تغير المسطحات المائية', 'Water Extent Monitoring'],
                impact: ['مقترح تخطيطي', 'Planning Proposal'],
                desc: [
                    'مقارنة نتائج الرصد بين الفترات الزمنية لتقييم التغيرات المكانية.',
                    'Compare observations across periods to assess spatial changes.'
                ]
            },
            {
                basin: ['حوض غواياس السفلي', 'Lower Guayas Basin'],
                title: ['متابعة الموارد المائية الساحلية', 'Coastal Water Monitoring'],
                impact: ['مقترح تخطيطي', 'Planning Proposal'],
                desc: [
                    'دمج رصد الأقمار الصناعية مع بيانات المياه الساحلية والقياسات المحلية.',
                    'Combine satellite observations with coastal water data and local measurements.'
                ]
            },
            {
                basin: ['حوض داولي', 'Daule Basin'],
                title: ['تقييم تغير المياه المتاحة', 'Available Water Assessment'],
                impact: ['مقترح تخطيطي', 'Planning Proposal'],
                desc: [
                    'متابعة تغير المسطحات المائية لدعم تقييم الموارد المائية.',
                    'Monitor water extent changes to support water-resource assessment.'
                ]
            },
            {
                basin: ['حوض فينسيس', 'Vinces Basin'],
                title: ['متابعة الأراضي الزراعية', 'Agricultural Land Monitoring'],
                impact: ['مقترح تخطيطي', 'Planning Proposal'],
                desc: [
                    'مقارنة بيانات المياه والارتفاع لدعم التخطيط الزراعي.',
                    'Compare water and elevation data to support agricultural planning.'
                ]
            }
        ]
    };

    const selected = strategies[season] || strategies.flood;
    const cards = selected.map(item => ({
        basin: item.basin[language === 'ar' ? 0 : 1],
        title: item.title[language === 'ar' ? 0 : 1],
        impact: item.impact[language === 'ar' ? 0 : 1],
        desc: item.desc[language === 'ar' ? 0 : 1]
    }));

    res.json({
        source: 'planning-proposals',
        generatedByAI: false,
        season: strategies[season] ? season : 'flood',
        cards
    });
});


// HYDROVISION GEOJSON STATIC ROUTES
app.get('/data/nasa/basins.geojson', (req, res) => {
    const file = path.join(__dirname, 'data', 'nasa', 'basins.geojson');
    if (!fs.existsSync(file)) {
        return res.status(404).json({ error: 'Basin GeoJSON not found' });
    }
    res.sendFile(file);
});

app.get('/data/reference/hydrorivers/guayas_rivers.geojson', (req, res) => {
    const file = path.join(__dirname, 'data', 'reference', 'hydrorivers', 'guayas_rivers.geojson');
    if (!fs.existsSync(file)) {
        return res.status(404).json({ error: 'River GeoJSON not found' });
    }
    res.sendFile(file);
});



// HYDROVISION_ASSISTANT_API_V2
app.post('/api/assistant', (req, res) => {
    try {
        const body = req.body || {};
        const question = String(body.question || '').trim().slice(0, 1000);
        const lang = ['ar', 'en', 'es'].includes(body.lang) ? body.lang : 'en';
        const selectedBasin = BASINS[body.basinId] ? body.basinId : 'babahoyo';

        if (!question) {
            return res.status(400).json({ error: 'Please enter a question.' });
        }

        const rows = loadNASAResults();
        const riverPath = path.join(__dirname, 'data', 'reference', 'hydrorivers', 'guayas_rivers_summary.json');

        let riverData = null;
        try {
            riverData = JSON.parse(fs.readFileSync(riverPath, 'utf8'));
        } catch (_) {}

        const names = {
            ar: {
                babahoyo: 'باباهويو',
                lower_guayas: 'غواياس السفلي',
                daule: 'داولي',
                vinces: 'فينسيس'
            },
            en: {
                babahoyo: 'Babahoyo',
                lower_guayas: 'Lower Guayas',
                daule: 'Daule',
                vinces: 'Vinces'
            },
            es: {
                babahoyo: 'Babahoyo',
                lower_guayas: 'Guayas inferior',
                daule: 'Daule',
                vinces: 'Vinces'
            }
        };

        const text = {
            ar: {
                intro: 'وفقًا لبيانات المشروع:',
                basin: 'الحوض',
                area: 'المساحة الجديدة المصنفة',
                open: 'المياه المفتوحة الجديدة',
                vegetation: 'مؤشر الغطاء النباتي المتأثر',
                percent: 'النسبة من مساحة المشهد الصالحة',
                coverage: 'تغطية المشهد',
                elevation: 'متوسط الارتفاع',
                slope: 'متوسط الانحدار',
                hand: 'متوسط HAND التقريبي',
                comparison: 'مقارنة الأحواض الأربعة حسب المساحة الجديدة المصنفة:',
                method: 'يستخدم المشروع بيانات NASA NISAR Level-2 GCOV. تتم مقارنة رصد الحدث بتاريخ 31 أكتوبر 2026 بنافذة خط أساس من 1 يونيو إلى 15 أكتوبر 2026. ويستخدم التصنيف عتبات للمياه المفتوحة وتغير استجابة الغطاء النباتي.',
                limits: 'النتائج تقديرات تصنيفية أولية وليست إنذارًا رسميًا أو احتمالًا للفيضان. مؤشر الغطاء النباتي لا يؤكد الغمر ميدانيًا، ونسبة الفيضان هي نسبة المساحة المصنفة إلى مساحة المشهد الصالحة وليست احتمالًا إحصائيًا. كما أن تغطية المشهد تختلف بين الأحواض، وحوض غواياس السفلي تجميعي ويتداخل مع تصريف الأحواض الأعلى.',
                sectors: 'يمكن استخدام النتائج المكانية لدراسة تعرض الزراعة والصيد والتجارة والنقل والثروة الحيوانية. لكن البيانات الحالية لا تحتوي على طبقات تفصيلية كافية لإثبات خسائر أو أعداد متضررين. نحتاج إلى بيانات استخدام الأراضي والطرق والمزارع ومناطق الصيد والتجارة.',
                rivers: 'ملخص شبكة الأنهار من HydroRIVERS v1.0 وHydroBASINS level 12:',
                segments: 'مقاطع الأنهار',
                length: 'إجمالي أطوال المقاطع بالكيلومتر',
                catchments: 'الأحواض الفرعية',
                noRiver: 'لا تتوفر بيانات شبكة الأنهار لهذا الحوض حاليًا.',
                noData: 'لا توجد بيانات تحليل متاحة لهذا الحوض في ملف NASA الحالي.',
                noMetric: 'غير متاح',
                general: 'أقدر أشرح بيانات الأحواض الأربعة، المساحة المصنفة، المياه المفتوحة، الغطاء النباتي، الارتفاع والانحدار، شبكة الأنهار، مصادر البيانات، طريقة التصنيف وحدود الدراسة. جرّب تسأل عن معلومة محددة أو تذكر اسم الحوض.',
                note: 'ملاحظة: المساحة المصنفة ليست مساحة أضرار مؤكدة.',
                why: 'الاختلاف بين الأحواض قد يرتبط بالمساحة الجغرافية، وتوزيع المياه والغطاء الأرضي، وطبيعة التضاريس، وتغطية صور الأقمار الصناعية. الأرقام وحدها لا تثبت سببًا مباشرًا.',
                ranking: 'أكبر مساحة جديدة مصنفة في البيانات الحالية هي',
                highestPercent: 'أعلى نسبة من مساحة المشهد الصالحة هي',
                missing: 'لا توجد بيانات كافية للإجابة عن هذا الجزء.'
            },
            en: {
                intro: 'Based on the available project data:',
                basin: 'Basin',
                area: 'Classified new area',
                open: 'New open water',
                vegetation: 'Flooded-vegetation proxy',
                percent: 'Share of valid scene area',
                coverage: 'Scene coverage',
                elevation: 'Mean elevation',
                slope: 'Mean slope',
                hand: 'Approximate mean HAND',
                comparison: 'Comparison of the four basins by classified new area:',
                method: 'The project uses NASA NISAR Level-2 GCOV data. It compares the 31 October 2026 event observation with a baseline search window from 1 June to 15 October 2026. Classification thresholds are applied to open water and vegetation-response changes.',
                limits: 'These are provisional classification estimates, not official warnings or flood probabilities. The vegetation indicator does not confirm flooding in the field. Flood percentage is classified area divided by valid scene area, not a statistical probability. Scene coverage differs between basins, and Lower Guayas is a cumulative downstream catchment that overlaps upstream drainage.',
                sectors: 'The spatial results can support studies of agriculture, fishing, trade, transportation and livestock exposure. However, the current data do not contain enough detailed layers to establish losses or affected-person counts. Land-use, road, farm, fishing and commercial datasets are needed.',
                rivers: 'River-network summary from HydroRIVERS v1.0 and HydroBASINS level 12:',
                segments: 'River segments',
                length: 'Total segment length (km)',
                catchments: 'Sub-catchments',
                noRiver: 'River-network data are not available for this basin.',
                noData: 'No analysis data are available for this basin in the current NASA file.',
                noMetric: 'Not available',
                general: 'I can explain the four basins, classified area, open water, vegetation proxy, elevation, slope, river network, data sources, classification method and study limitations. Ask about a specific metric or mention a basin name.',
                note: 'Note: classified area is not confirmed damage area.',
                why: 'Differences between basins may relate to geographic size, water and land-cover distribution, terrain, and satellite-scene coverage. The numbers alone do not establish a direct cause.',
                ranking: 'The largest classified new area in the current data is',
                highestPercent: 'The highest share of valid scene area is',
                missing: 'There is not enough available data to answer this part.'
            },
            es: {
                intro: 'Según los datos disponibles del proyecto:',
                basin: 'Cuenca',
                area: 'Área nueva clasificada',
                open: 'Agua abierta nueva',
                vegetation: 'Indicador de vegetación inundada',
                percent: 'Porcentaje del área válida de la escena',
                coverage: 'Cobertura de la escena',
                elevation: 'Elevación media',
                slope: 'Pendiente media',
                hand: 'HAND medio aproximado',
                comparison: 'Comparación de las cuatro cuencas por área nueva clasificada:',
                method: 'El proyecto utiliza datos NASA NISAR Level-2 GCOV. Compara la observación del evento del 31 de octubre de 2026 con una ventana de referencia del 1 de junio al 15 de octubre de 2026. La clasificación aplica umbrales al agua abierta y a los cambios en la respuesta de la vegetación.',
                limits: 'Son estimaciones provisionales, no alertas oficiales ni probabilidades de inundación. El indicador de vegetación no confirma inundaciones en campo. El porcentaje es el área clasificada dividida por el área válida de la escena, no una probabilidad estadística. La cobertura varía entre cuencas y Guayas inferior es una cuenca acumulativa que se superpone con el drenaje aguas arriba.',
                sectors: 'Los resultados espaciales pueden apoyar estudios sobre agricultura, pesca, comercio, transporte y ganadería. Sin embargo, los datos actuales no contienen suficientes capas detalladas para demostrar pérdidas ni contar personas afectadas. Se necesitan datos de uso del suelo, carreteras, granjas, pesca y comercio.',
                rivers: 'Resumen de la red fluvial de HydroRIVERS v1.0 y HydroBASINS nivel 12:',
                segments: 'Segmentos fluviales',
                length: 'Longitud total de segmentos (km)',
                catchments: 'Subcuencas',
                noRiver: 'No hay datos de la red fluvial para esta cuenca.',
                noData: 'No hay datos de análisis disponibles para esta cuenca.',
                noMetric: 'No disponible',
                general: 'Puedo explicar las cuatro cuencas, el área clasificada, el agua abierta, el indicador de vegetación, la elevación, la pendiente, la red fluvial, las fuentes, el método y las limitaciones. Pregunta por una métrica concreta o menciona una cuenca.',
                note: 'Nota: el área clasificada no representa daños confirmados.',
                why: 'Las diferencias pueden relacionarse con el tamaño geográfico, la distribución del agua y la cobertura terrestre, el terreno y la cobertura de las imágenes satelitales. Los números por sí solos no demuestran una causa directa.',
                ranking: 'La mayor área nueva clasificada en los datos actuales es',
                highestPercent: 'La mayor proporción del área válida de la escena es',
                missing: 'No hay suficientes datos para responder a esta parte.'
            }
        }[lang];

        const normalizeQuestion = value => String(value || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[\u064B-\u065F\u0670]/g, '')
            .replace(/[أإآ]/g, 'ا')
            .replace(/ى/g, 'ي')
            .replace(/[ؤئ]/g, 'ء')
            .replace(/[_-]/g, ' ')
            .replace(/[؟?!.,؛:()[\]{}]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const q = normalizeQuestion(question);
        const has = (...terms) => terms.some(term => q.includes(normalizeQuestion(term)));

        const basinAliases = {
            babahoyo: ['babahoyo', 'باباهويو', 'باباهويو'],
            lower_guayas: ['lower guayas', 'lower_guayas', 'guayas inferior', 'guayas bajo', 'غواياس السفلي', 'الغواياس السفلي'],
            daule: ['daule', 'داولي', 'داؤلي'],
            vinces: ['vinces', 'فينسيس', 'فينس']
        };

        let basinId = selectedBasin;
        for (const [id, aliases] of Object.entries(basinAliases)) {
            if (aliases.some(alias => q.includes(normalizeQuestion(alias)))) {
                basinId = id;
                break;
            }
        }

        const getRow = id => findBasinRow(rows, id);
        const value = (row, key) => getMetric(row, key);
        const fmt = n => n === null || n === undefined
            ? text.noMetric
            : Number(n).toLocaleString(lang === 'ar' ? 'ar-EG' : lang === 'es' ? 'es-ES' : 'en-US', { maximumFractionDigits: 2 });

        const intents = {
            area: has('area', 'how much flooded', 'flood extent', 'flooded area', 'km2', 'km²', 'مساحة', 'المساحه', 'مساحه الغمر', 'مساحة الفيضان', 'قد ايه', 'كم تبلغ', 'área', 'superficie', 'extension inundada'),
            open: has('open water', 'surface water', 'water area', 'water extent', 'المياه المفتوحة', 'المياه', 'مياه جديده', 'الماء', 'agua abierta', 'agua superficial'),
            vegetation: has('vegetation', 'vegetated', 'plants', 'crops', 'crop', 'الغلاف النباتي', 'الغطاء النباتي', 'النباتات', 'المحاصيل', 'زراعه', 'vegetacion', 'cultivos', 'plantas'),
            percent: has('percent', 'percentage', 'proportion', 'ratio', 'percentage flooded', 'نسبه', 'النسبة', 'نسبه الغمر', 'كم في الميه', 'porcentaje', 'proporcion'),
            coverage: has('coverage', 'scene coverage', 'valid scene', 'تغطيه', 'تغطية المشهد', 'تغطية الصور', 'cobertura'),
            elevation: has('elevation', 'altitude', 'height above sea', 'ارتفاع', 'الارتفاع', 'منسوب', 'elevacion', 'altitud'),
            slope: has('slope', 'terrain steepness', 'انحدار', 'الميل', 'الانحدار', 'pendiente'),
            hand: has('hand', 'height above nearest drainage', 'drainage height', 'ارتفاع عن النهر', 'المسافة عن النهر', 'altura sobre drenaje'),
            method: has('method', 'how measured', 'how did you calculate', 'threshold', 'classification', 'nisar', 'satellite', 'source', 'data source', 'منهج', 'المنهج', 'طريقة', 'ازاي اتحسب', 'كيف تم', 'عتبه', 'تصنيف', 'مصدر', 'قمر صناعي', 'بيانات', 'metodo', 'como se calcula', 'umbral', 'fuente', 'satelite'),
            limits: has('limit', 'limitations', 'reliable', 'accuracy', 'accurate', 'confirmed', 'verified', 'official', 'warning', 'probability', 'risk', 'هل اكيد', 'هل مؤكد', 'موثوق', 'دقيق', 'حدود', 'قيود', 'انذار', 'احتمال', 'خطر', 'validacion', 'fiable', 'precision', 'limite', 'alerta', 'probabilidad', 'riesgo'),
            sectors: has('agriculture', 'agricultural', 'farm', 'farms', 'farming', 'crop', 'fishing', 'fishery', 'trade', 'commercial', 'transport', 'road', 'livestock', 'زراعه', 'الزراعة', 'مزارع', 'محاصيل', 'صيد', 'سمك', 'تجاره', 'نقل', 'طرق', 'ماشية', 'ثروة حيوانية', 'agricultura', 'pesca', 'comercio', 'transporte', 'carreteras', 'ganaderia'),
            rivers: has('river', 'rivers', 'stream', 'hydrorivers', 'river network', 'نهر', 'انهار', 'الانهار', 'مجرى', 'شبكة الانهار', 'مقاطع', 'rio', 'rios', 'red fluvial'),
            comparison: has('compare', 'comparison', 'compare all', 'all basins', 'which basin', 'largest basin', 'highest basin', 'versus', ' vs ', 'مقارن', 'قارن', 'مقارنة', 'كل الاحواض', 'الاحواض كلها', 'اي حوض', 'اكبر حوض', 'اعلى حوض', 'comparar', 'comparacion', 'todas las cuencas', 'que cuenca', 'mayor cuenca'),
            why: has('why', 'reason', 'cause', 'explain why', 'ليه', 'لماذا', 'السبب', 'اسباب', 'عشان ايه', 'por que', 'causa', 'razon')
        };

        const row = getRow(basinId);
        const output = [];
        const add = value => {
            if (value && !output.includes(value)) output.push(value);
        };

        const allRows = Object.keys(BASINS).map(id => ({
            id,
            row: getRow(id)
        })).filter(item => item.row);

        if (intents.comparison) {
            const ranked = allRows.map(item => ({
                id: item.id,
                total: value(item.row, 'new_flood_total_km2'),
                percent: value(item.row, 'new_flood_pct_of_valid_scene_area')
            })).sort((a, b) => (b.total || 0) - (a.total || 0));

            add(text.comparison);
            ranked.forEach((item, index) => {
                add((index + 1) + '. ' + names[lang][item.id] + ': ' +
                    fmt(item.total) + ' km² (' + fmt(item.percent) + '%)');
            });

            const byPercent = [...ranked].sort((a, b) => (b.percent || 0) - (a.percent || 0))[0];
            if (ranked.length) {
                add(text.ranking + ' ' + names[lang][ranked[0].id] + '.');
                add(text.highestPercent + ' ' + names[lang][byPercent.id] + '.');
            }
        }

        if (intents.area || intents.open || intents.vegetation || intents.percent || intents.coverage ||
            intents.elevation || intents.slope || intents.hand || (!intents.comparison && !Object.values(intents).some(Boolean))) {

            if (!row) {
                add(text.noData);
            } else {
                add(text.intro + ' ' + text.basin + ': ' + names[lang][basinId] + '.');

                if (intents.area || (!intents.open && !intents.vegetation && !intents.percent &&
                    !intents.coverage && !intents.elevation && !intents.slope && !intents.hand &&
                    !intents.comparison && !Object.values(intents).some(Boolean))) {
                    add(text.area + ': ' + fmt(value(row, 'new_flood_total_km2')) + ' km².');
                }
                if (intents.open) add(text.open + ': ' + fmt(value(row, 'new_open_water_km2')) + ' km².');
                if (intents.vegetation) add(text.vegetation + ': ' + fmt(value(row, 'flooded_vegetation_proxy_km2')) + ' km².');
                if (intents.percent) add(text.percent + ': ' + fmt(value(row, 'new_flood_pct_of_valid_scene_area')) + '%.');
                if (intents.coverage) add(text.coverage + ': ' + fmt(value(row, 'scene_coverage_pct')) + '%.');
                if (intents.elevation) add(text.elevation + ': ' + fmt(value(row, 'mean_elevation_m')) + ' m.');
                if (intents.slope) add(text.slope + ': ' + fmt(value(row, 'mean_slope_deg')) + '°.');
                if (intents.hand) add(text.hand + ': ' + fmt(value(row, 'mean_flood_HAND_approx_m')) + ' m.');
            }
        }

        if (intents.method) add(text.method);
        if (intents.limits) add(text.limits);
        if (intents.sectors) add(text.sectors);
        if (intents.why) add(text.why);

        if (intents.rivers) {
            const r = riverData && riverData.basins && riverData.basins[basinId];
            if (!r) {
                add(text.noRiver);
            } else {
                add(text.rivers);
                add(text.basin + ': ' + names[lang][basinId]);
                add(text.catchments + ': ' + r.level12Catchments);
                add(text.segments + ': ' + r.riverSegments);
                add(text.length + ': ' + fmt(Number(r.totalSegmentLengthKm)) + ' km');
            }
        }

        if (!output.length) add(text.general);

        if (!rows.length) add(text.noData);

        res.json({
            ok: true,
            answer: output.join('\n\n'),
            language: lang,
            basinId,
            detectedIntents: Object.keys(intents).filter(key => intents[key]),
            source: 'local-project-data-intent-engine',
            generatedByAI: false
        });
    } catch (error) {
        console.error('Assistant error:', error);
        res.status(500).json({ error: 'Assistant could not process the question.' });
    }
});


// HV_OFFICIAL_FLOOD_ALERTS_CAP_V1
function hvXmlDecode(value) {
    return String(value || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function hvXmlTag(xml, name) {
    const re = new RegExp('<(?:[\\w.-]+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?' + name + '\\s*>', 'i');
    const match = String(xml || '').match(re);
    return match ? hvXmlDecode(match[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}
function hvParseCapFeed(xml, basinId) {
    const areasByBasin = {
        babahoyo: ['los rios', 'babahoyo'],
        vinces: ['los rios', 'vinces'],
        daule: ['guayas', 'daule'],
        lower_guayas: ['guayas', 'los rios', 'lower guayas']
    };
    const wantedAreas = areasByBasin[basinId] || areasByBasin.babahoyo;
    const normalizeText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const alerts = [];
    const capBlocks = [...String(xml).matchAll(/<(?:[\w.-]+:)?alert\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?alert\\s*>/gi)].map(m => m[1]);
    for (const block of capBlocks) {
        const status = hvXmlTag(block, 'status') || 'Actual';
        const scope = hvXmlTag(block, 'scope') || 'Public';
        if (!/^actual$/i.test(status) || !/^public$/i.test(scope)) continue;
        const infos = [...block.matchAll(/<(?:[\w.-]+:)?info\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?info\\s*>/gi)].map(m => m[1]);
        for (const info of (infos.length ? infos : [block])) {
            const headline = hvXmlTag(info, 'headline') || hvXmlTag(info, 'event') || 'Official weather or hydrological alert';
            const event = hvXmlTag(info, 'event');
            const description = hvXmlTag(info, 'description');
            const instruction = hvXmlTag(info, 'instruction');
            const areas = [...info.matchAll(/<(?:[\w.-]+:)?areaDesc(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?areaDesc\\s*>/gi)]
                .map(m => hvXmlDecode(m[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
            const searchable = normalizeText([headline, event, description, instruction, areas.join(' ')].join(' '));
            const areaText = normalizeText(areas.join(' ') + ' ' + description);
            if (!wantedAreas.some(area => areaText.includes(area))) continue;
            if (!/(lluv|rain|precip|torment|storm|inund|flood|crecid|river|hidrolog)/i.test(searchable)) continue;
            const expires = hvXmlTag(info, 'expires');
            if (expires && Number.isFinite(Date.parse(expires)) && Date.parse(expires) < Date.now()) continue;
            const severityRaw = hvXmlTag(info, 'severity').toLowerCase();
            const severity = severityRaw === 'extreme' ? 'extreme' : severityRaw === 'severe' ? 'severe' : severityRaw === 'moderate' ? 'moderate' : 'minor';
            const identifier = hvXmlTag(block, 'identifier') || hvXmlTag(block, 'sender') + '|' + hvXmlTag(block, 'sent') + '|' + headline;
            alerts.push({
                id: identifier + '|' + headline,
                headline, event, description, instruction, areas,
                severity, urgency: hvXmlTag(info, 'urgency'),
                certainty: hvXmlTag(info, 'certainty'),
                sent: hvXmlTag(block, 'sent'),
                effective: hvXmlTag(info, 'effective'),
                onset: hvXmlTag(info, 'onset'),
                expires,
                source: 'INAMHI CAP',
                sourceUrl: 'https://servicios.inamhi.gob.ec/alertas/'
            });
        }
    }
    if (!capBlocks.length) {
        const items = [...String(xml).matchAll(/<item\b[^>]*>([\\s\\S]*?)<\\/item\\s*>/gi)].map(m => m[1]);
        for (const item of items) {
            const headline = hvXmlTag(item, 'title') || 'Official weather or hydrological alert';
            const description = hvXmlTag(item, 'description');
            const link = hvXmlTag(item, 'link');
            const searchable = normalizeText([headline, description].join(' '));
            if (!wantedAreas.some(area => searchable.includes(area))) continue;
            if (!/(lluv|rain|precip|torment|storm|inund|flood|crecid|river|hidrolog)/i.test(searchable)) continue;
            const level = searchable.includes('extrema') || searchable.includes('extreme') ? 'extreme'
                : searchable.includes('severa') || searchable.includes('severe') ? 'severe'
                : searchable.includes('moderada') || searchable.includes('moderate') ? 'moderate' : 'minor';
            alerts.push({
                id: hvXmlTag(item, 'guid') || link || headline,
                headline, event: headline, description, instruction: '',
                areas: wantedAreas.filter(area => searchable.includes(area)),
                severity: level, sent: hvXmlTag(item, 'pubDate'),
                expires: '', source: 'INAMHI CAP RSS',
                sourceUrl: link || 'https://servicios.inamhi.gob.ec/alertas/'
            });
        }
    }
    return alerts;
}
app.get('/api/flood-alerts', async (req, res) => {
    const basinId = String(req.query.basinId || 'babahoyo').toLowerCase();
    if (!BASINS[basinId]) return res.status(400).json({ available: false, error: 'Invalid basin ID', alerts: [] });
    try {
        const response = await fetch('https://cap-sources.s3.amazonaws.com/ec-inamhi-es/rss.xml', {
            headers: { 'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8', 'User-Agent': 'HydroVision-Flood-Alert-Monitor/1.0' },
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error('Official CAP feed returned HTTP ' + response.status);
        const xml = await response.text();
        const alerts = hvParseCapFeed(xml, basinId);
        res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
        res.json({
            available: true,
            basinId,
            checkedAt: new Date().toISOString(),
            alerts,
            count: alerts.length,
            source: 'INAMHI Common Alerting Protocol (CAP) feed',
            sourceUrl: 'https://servicios.inamhi.gob.ec/alertas/'
        });
    } catch (error) {
        console.error('Flood alert feed error:', error.message);
        res.status(503).json({
            available: false,
            basinId,
            checkedAt: new Date().toISOString(),
            alerts: [],
            error: 'Official alert feed is temporarily unavailable.',
            sourceUrl: 'https://servicios.inamhi.gob.ec/alertas/'
        });
    }
});

app.use((req, res) => {
    res.status(404).json({ error: 'Route not found', path: req.path });
});

app.listen(PORT, () => {
    console.log(`HydroVision running at http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
});
