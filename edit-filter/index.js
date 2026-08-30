const vm = require('vm');
const mongoose = require('mongoose');
const crypto = require('crypto');

const utils = require('../../utils');
const ACL = require('../../class/acl');
const Document = require('../../schemas/document');
const History = require('../../schemas/history');
const { addACLGroupItem } = require('../../routes/aclgroup');




const FILTER_NAMESPACE = '편집필터';
const FILTER_CACHE_TTL = 0; 
const WARNING_CONFIRM_TTL = 5 * 60 * 1000;
const TOP_LEVEL_FIELDS = ['namespace', 'namespaces', 'condition', 'action', 'actions'];




function parseDuration(durationInput) {
    if (typeof durationInput === 'number') return durationInput;
    if (typeof durationInput !== 'string') return 0;

    const match = durationInput.trim().match(/^(\d+(?:\.\d+)?)\s*([smhwMy])?$/);
    if (!match) return Number(durationInput) || 0;

    const value = parseFloat(match[1]);
    const unit = match[2] || 's';

    const unitToSeconds = {
        s: 1,            
        m: 60,           
        h: 3600,         
        d: 86400,        
        w: 604800,       
        M: 2419200,      
        y: 29030400,     
    };

    return value * (unitToSeconds[unit] || 1);
}




const EditFilterLog = mongoose.models.EditFilterLog || mongoose.model('EditFilterLog', new mongoose.Schema({
    filterId: { type: String, required: true, index: true },
    namespace: { type: String, index: true },
    title: { type: String, index: true },
    uuid: { type: String, index: true },
    ver: Number,
    log: String,
    context: String,
    matchedActions: [String],
    createdAt: { type: Date, default: Date.now, index: true }
}));





function splitTopLevelFields(content) {
    const fieldRe = new RegExp(`^(${TOP_LEVEL_FIELDS.join('|')})\\s*:`);
    const result = {};
    let depth = 0;
    let currentKey = null;
    let buffer = '';
    let i = 0;
    let inString = null;

    while(i < content.length) {
        const ch = content[i];

        if(inString) {
            if(ch === '\\') { buffer += ch + (content[i + 1] ?? ''); i += 2; continue; }
            if(ch === inString) inString = null;
            buffer += ch;
            i++;
            continue;
        }
        if(ch === '\'' || ch === '"' || ch === '`') {
            inString = ch;
            buffer += ch;
            i++;
            continue;
        }

        if('([{'.includes(ch)) depth++;
        else if(')]}'.includes(ch)) depth--;

        if(depth === 0) {
            const rest = content.slice(i);
            const m = rest.match(fieldRe);
            const prevCh = content[i - 1];
            if(m && (i === 0 || /[\s,;\n]/.test(prevCh))) {
                if(currentKey) result[currentKey] = buffer.trim().replace(/[,;]\s*$/, '');
                currentKey = m[1];
                i += m[0].length;
                buffer = '';
                continue;
            }
        }

        buffer += ch;
        i++;
    }
    if(currentKey) result[currentKey] = buffer.trim().replace(/[,;]\s*$/, '');
    return result;
}

function evalStatic(exprText) {
    const sandbox = { console };
    vm.createContext(sandbox);

    const sanitizedExpr = exprText.replace(/duration\s*:\s*(\d+[smhwMy])/g, 'duration: "$1"');

    return vm.runInContext(`(${sanitizedExpr})`, sandbox, { timeout: 200 });
}

function compileConditionExpr(exprText) {
    const sandbox = { console };
    vm.createContext(sandbox);

    
    let sanitizedExpr = exprText.replace(/\br(['"])(.*?)\1/g, (match, quote, content) => {
        return JSON.stringify(content);
    });

    
    sanitizedExpr = sanitizedExpr.replace(/\br(\/.*?\/[gimsuy]*)/g, (match, p1) => {
        return JSON.stringify(p1);
    });

    const fn = vm.runInContext(
        `(function(namespace, title, ver, uuid, acl, rawContext, log, document) {
            
            const context = {
                length: rawContext ? rawContext.length : 0,
                valueOf: () => rawContext,
                toString: () => rawContext,
                includes: function(pattern) {
                    if (typeof pattern === 'string') {
                        let cleaned = pattern.trim();

                        
                        const regMatch = cleaned.match(/^\\/(.*)\\/([gimsuy]*)$/);
                        if (regMatch) {
                            try {
                                const regex = new RegExp(regMatch[1], regMatch[2]);
                                return regex.test(rawContext);
                            } catch(e) {
                                console.error('편집필터 정규식 파싱 실패:', e);
                            }
                        }
                    }

                    if (pattern instanceof RegExp) {
                        return pattern.test(rawContext);
                    }

                    return rawContext.includes(pattern);
                }
            };

            return (${sanitizedExpr});
        })`,
        sandbox,
        { timeout: 200 }
    );

    return ctx => fn(ctx.namespace, ctx.title, ctx.ver, ctx.uuid, ctx.acl, ctx.context, ctx.log, ctx.document);
}

async function compileFilterDoc(content) {
    const trimmed = content.trim();

    if(/^module\.exports\s*=/.test(trimmed)) {
        const sandbox = { module: { exports: {} }, exports: {}, console };
        vm.createContext(sandbox);
        vm.runInContext(
            `(function(module, exports) {\n${content}\n})(module, exports);`,
            sandbox,
            { timeout: 200 }
        );
        const def = sandbox.module.exports;
        const rawNs = def.namespaces ?? def.namespace ?? [];
        return {
            namespaces: Array.isArray(rawNs) ? rawNs : [rawNs],
            condition: def.condition,
            actions: def.actions ?? def.action ?? []
        };
    }

    const fields = splitTopLevelFields(content);

    const rawNsExpr = fields.namespace ?? fields.namespaces;
    let namespaces = [];
    if (rawNsExpr) {
        const evaled = evalStatic(rawNsExpr);
        namespaces = Array.isArray(evaled) ? evaled : [evaled];
    }

    const actions = (fields.action ?? fields.actions)
        ? evalStatic(fields.action ?? fields.actions)
        : [];
    const condition = fields.condition ? compileConditionExpr(fields.condition) : null;

    return { namespaces, condition, actions };
}




let filterCache = { loadedAt: 0, filters: [] };
const warnedCache = new Map();

function pruneWarnedCache() {
    const now = Date.now();
    for(const [key, ts] of warnedCache) {
        if(now - ts > WARNING_CONFIRM_TTL) warnedCache.delete(key);
    }
}

async function loadFilters() {
    if(FILTER_CACHE_TTL > 0 && Date.now() - filterCache.loadedAt < FILTER_CACHE_TTL) return filterCache.filters;

    const docs = await Document.find({
        namespace: FILTER_NAMESPACE,
        contentExists: true
    }).sort({ title: 1 }).lean();

    const loaded = [];
    for(const doc of docs) {
        const rev = await History.findOne({ document: doc.uuid }).sort({ rev: -1 }).lean();
        if(!rev?.content) continue;

        let def;
        try {
            def = await compileFilterDoc(rev.content);
        } catch(e) {
            console.error(`편집필터: ${FILTER_NAMESPACE}:${doc.title} 컴파일 실패:`, e);
            continue;
        }

        if(typeof def?.condition !== 'function' || !Array.isArray(def.actions)) {
            console.warn(`편집필터: ${FILTER_NAMESPACE}:${doc.title} 형식이 올바르지 않음 (condition/action 누락)`);
            continue;
        }

        loaded.push({
            id: doc.title,
            namespaces: Array.isArray(def.namespaces) ? def.namespaces : [],
            condition: def.condition,
            actions: def.actions
        });
    }

    filterCache = { loadedAt: Date.now(), filters: loaded };
    return loaded;
}

function extractDocumentInfo(req) {
    const rawPath = req.url.split('?')[0];

    let prefix = null;
    let isMove = false;

    if(rawPath.startsWith('/edit/')) prefix = '/edit/';
    else if(rawPath.startsWith('/new_edit_request/')) prefix = '/new_edit_request/';
    else if(rawPath.startsWith('/move/')) {
        prefix = '/move/';
        isMove = true;
    }

    if(!prefix) return null;

    const name = decodeURIComponent(rawPath.slice(prefix.length));
    return { name: name || null, isMove };
}


function isNamespaceMatched(filterNamespaces, targetNamespace) {
    if (!filterNamespaces || !filterNamespaces.length) return true;

    const excludeList = [];
    const includeList = [];

    for (const ns of filterNamespaces) {
        if (typeof ns === 'string' && ns.startsWith('!')) {
            excludeList.push(ns.slice(1));
        } else if (typeof ns === 'string') {
            includeList.push(ns);
        }
    }

    if (excludeList.includes(targetNamespace)) {
        return false;
    }

    if (includeList.length > 0) {
        return includeList.includes(targetNamespace);
    }

    return true;
}

module.exports = {
    name: 'edit-filter',
    type: 'preHook',
    condition: req => req.method === 'POST' && extractDocumentInfo(req) != null,
    handler: async (req, res) => {
        const info = extractDocumentInfo(req);
        if(!info) return;

        let targetDocName = info.name;
        let isMoveRequest = info.isMove;

        if (isMoveRequest) {
            if (!req.body?.title) return;
            targetDocName = req.body.title;
        } else {
            if (req.body?.agree !== 'Y') return;
            if (req.body?.text == null) return;
        }

        const document = utils.parseDocumentName(targetDocName);
        const { namespace, title } = document;

        if (namespace === FILTER_NAMESPACE) return;

        const filters = await loadFilters();
        const targetFilters = filters.filter(f => isNamespaceMatched(f.namespaces, namespace));
        if(!targetFilters.length) return;

        const dbDocument = await Document.findOne({ namespace, title });

        const latestRev = dbDocument
            ? await History.findOne({ document: dbDocument.uuid }).sort({ rev: -1 })
            : null;
        const ver = latestRev?.rev ?? 0;

        const acl = await ACL.get({ document: dbDocument }, document);

        const ctx = {
            namespace,
            title,
            ver,
            uuid: req.user?.uuid ?? null,
            acl,
            context: req.body.text ?? '',
            log: req.body.log ?? '',
            document: {
                move: (targetTitle) => {
                    return title === targetTitle || `${namespace}:${title}` === targetTitle;
                }
            }
        };

        for(const filter of targetFilters) {
            let matched;
            try {
                matched = await filter.condition(ctx);
            } catch(e) {
                console.error(`편집 필터 '${filter.id}' condition 실행 오류:`, e);
                continue;
            }
            if(!matched) continue;

            for(const action of filter.actions) {
                if(res.headersSent || res.jsonProcessing) return;

                try {
                    switch(action.type) {
                        case 'log':
                            await EditFilterLog.create({
                                filterId: filter.id,
                                namespace,
                                title,
                                uuid: ctx.uuid,
                                ver,
                                log: ctx.log,
                                context: ctx.context.slice(0, 5000),
                                matchedActions: filter.actions.map(a => a.type)
                            });
                            break;

                        case 'warning': {
                            pruneWarnedCache();
                            const sig = crypto.createHash('sha1')
                                .update(`${ctx.context}\u0000${ctx.log}`)
                                .digest('hex');
                            const warnKey = `${ctx.uuid}:${namespace}:${title}:${filter.id}:${sig}`;

                            if(warnedCache.has(warnKey)) break;

                            warnedCache.set(warnKey, Date.now());
                            res.status(409).send(
                                action.message || '편집 필터 경고: 이 편집은 검토가 필요합니다. 계속하려면 다시 저장해주세요.'
                            );
                            return;
                        }

                        case 'captcha': {
                            const ok = await utils.middleValidateCaptcha(req, res, true);
                            if(!ok) return;
                            break;
                        }

                        case 'block': {
                            if(ctx.uuid) {
                                const durationSec = parseDuration(action.duration);
                                await addACLGroupItem({
                                    createdUserUuid: ctx.uuid,
                                    groupName: action.groupName || '차단',
                                    uuid: ctx.uuid,
                                    duration: durationSec * 1000,
                                    note: action.note || `편집 필터 ${filter.id}`,
                                    hideLog: Boolean(action.hidelog)
                                });
                            }
                            res.status(403).send(`편집필터 ${filter.id}에 의해 불허됨`);
                            return;
                        }

                        default:
                            console.warn('편집 필터: 알 수 없는 action.type', action.type);
                    }
                } catch(e) {
                    console.error(`편집 필터 '${filter.id}' action '${action.type}' 실행 오류:`, e);
                }
            }
        }
    }
};