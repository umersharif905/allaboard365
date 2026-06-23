# Prompt for Cursor

You are building a **Custom Domain configuration module** for the **Open-Enroll Admin Portal**.  
The goal is to let tenants configure a white-labeled domain for `app.open-enroll.com` (e.g., `portal.client.com`) with Azure Front Door integration.

---

## Requirements

### UI Flow
1. **Dropdown Selection**
   - User chooses from predefined subdomain options: `app`, `portal`, `enroll`.

2. **Domain Entry**
   - User types their root domain (e.g., `clientdomain.com`).

3. **Configure Button**
   - When clicked:
     - Calls backend API to create domain mapping in Azure Front Door.
     - Backend returns required DNS entries (CNAME + TXT with ASUID token).

4. **DNS Instructions**
   - Display required DNS records:
     - `CNAME` record for the chosen subdomain pointing to `app.open-enroll.com`.
     - `TXT` record with `asuid.<subdomain>` containing the Azure verification token.

5. **Verify Button**
   - Calls backend API to confirm DNS is correctly set.
   - UI updates with ✅ “Domain Verified” or ❌ “Verification Failed”.

6. **Enable SSL/TLS**
   - Checkbox enabled by default.
   - Backend requests managed cert from Azure Front Door after verification succeeds.

7. **Cancel / Reset Flow**
   - User can cancel the process or delete existing configuration.
   - On cancel:
     - Backend removes the domain from Azure Front Door.
     - UI resets to allow entering a new domain.

---

## Backend Integration

Expose these endpoints:

1. `POST /api/custom-domains/configure`
   - Body: `{ tenantId, subdomainOption, domainName }`
   - Action: Adds custom domain to Azure Front Door and generates ASUID TXT token.
   - Response:
     ```json
     {
       "cname": {
         "name": "portal",
         "value": "app.open-enroll.com"
       },
       "txt": {
         "name": "asuid.portal",
         "value": "verification-token-from-azure"
       }
     }
     ```

2. `POST /api/custom-domains/verify`
   - Body: `{ tenantId, subdomainOption, domainName }`
   - Action: Checks Azure Front Door for domain verification status.
   - Response: `{ "status": "verified" | "pending" | "failed" }`

3. `DELETE /api/custom-domains`
   - Body: `{ tenantId, subdomainOption, domainName }`
   - Action: Removes custom domain from Azure Front Door.

---

## UI Component (React + TypeScript + Material-UI)

Create component:  
`src/components/settings/CustomDomain.tsx`

Features:
- Dropdown for subdomain option (`app`, `portal`, `enroll`).
- Input for domain.
- “Configure” button → calls `POST /api/custom-domains/configure`.
- DNS instructions card showing returned records.
- “Verify” button → calls `POST /api/custom-domains/verify`.
- Verification status banner (green/red).
- SSL/TLS checkbox.
- “Cancel” button → calls `DELETE /api/custom-domains`.

---

## Acceptance Criteria
- User can set up a new custom domain and see DNS instructions.
- User can verify DNS records via UI.
- SSL/TLS is auto-enabled after verification.
- User can cancel/reset and start over.
- All changes persist to `Tenants.AdvancedSettings` in DB and Azure Front Door.

---

👉 Build the **frontend component** and **API integration stubs** to support this workflow.

# Custom Domain API Workflow (Azure Front Door Integration)

## Step 1: POST – Auth Token
**Purpose**: Get access token for Azure API calls.  
**Endpoint**:  
`POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`

**Body (x-www-form-urlencoded):**
```
client_id={clientId}
client_secret={clientSecret}
scope=https://management.azure.com/.default
grant_type=client_credentials
```

**Response:**
```json
{
  "token_type": "Bearer",
  "expires_in": 3600,
  "access_token": "eyJ0eXAiOiJK..."
}
```

---

## Step 2: PUT – Create New Client Record
**Purpose**: Register custom domain in Azure Front Door (AFD).  
**Endpoint**:  
`PUT https://management.azure.com/subscriptions/{subId}/resourceGroups/{rg}/providers/Microsoft.Cdn/profiles/{afdProfile}/customDomains/{customDomainName}?api-version=2024-02-01`

**Body:**
```json
{
  "properties": {
    "hostName": "portal.clientdomain.com"
  }
}
```

**Response:**
```json
{
  "name": "portal-clientdomain-com",
  "type": "Microsoft.Cdn/profiles/customDomains",
  "properties": {
    "hostName": "portal.clientdomain.com",
    "validationProperties": {
      "validationToken": "verification-token-from-azure"
    },
    "provisioningState": "Creating"
  }
}
```

---

## Step 3: GET – Fetch DNS Records Needed
**Purpose**: Show required CNAME + TXT to client.  
**Endpoint**:  
`GET https://management.azure.com/subscriptions/{subId}/resourceGroups/{rg}/providers/Microsoft.Cdn/profiles/{afdProfile}/customDomains/{customDomainName}?api-version=2024-02-01`

**Response:**
```json
{
  "properties": {
    "hostName": "portal.clientdomain.com",
    "validationProperties": {
      "validationToken": "verification-token-from-azure"
    }
  }
}
```

---

## Step 4: GET – Poll Until DNS Approved
**Purpose**: Wait for client DNS setup to propagate.  
**Endpoint**: same as Step 3  

**Check:**
- `"provisioningState": "Succeeded"` = ✅ verified.  
- `"provisioningState": "Failed"` = ❌ DNS not valid.  

**Frontend:**
- If pending → UI shows “Waiting for DNS verification…”  
- If paused → “Verify” button calls backend again to resume polling.

---

## Step 5: GET – Fetch the App Routes in oe-prod
**Purpose**: Retrieve current routes for Front Door app.  
**Endpoint**:  
`GET https://management.azure.com/subscriptions/{subId}/resourceGroups/{rg}/providers/Microsoft.Cdn/profiles/{afdProfile}/afdEndpoints/{endpointName}/routes?api-version=2024-02-01`

---

## Step 6: PATCH – Update Routes
**Purpose**: Add new hostname binding to existing route.  
**Endpoint**:  
`PATCH https://management.azure.com/subscriptions/{subId}/resourceGroups/{rg}/providers/Microsoft.Cdn/profiles/{afdProfile}/afdEndpoints/{endpointName}/routes/{routeName}?api-version=2024-02-01`

**Body:**
```json
{
  "properties": {
    "customDomains": [
      {
        "id": "/subscriptions/{subId}/resourceGroups/{rg}/providers/Microsoft.Cdn/profiles/{afdProfile}/customDomains/{customDomainName}"
      }
    ]
  }
}
```

---

## Step 7: PUT – Create Rule Set
**Purpose**: Add rules (redirects, rewrites, headers, etc.) for the new domain.  
**Endpoint**:  
`PUT https://management.azure.com/subscriptions/{subId}/resourceGroups/{rg}/providers/Microsoft.Cdn/profiles/{afdProfile}/ruleSets/{ruleSetName}?api-version=2024-02-01`

**Body:**
```json
{
  "properties": {
    "rules": [
      {
        "name": "RedirectRoot",
        "order": 1,
        "conditions": [
          {
            "name": "HostName",
            "parameters": {
              "operator": "Equal",
              "matchValues": [ "portal.clientdomain.com" ]
            }
          }
        ],
        "actions": [
          {
            "name": "UrlRewrite",
            "parameters": {
              "sourcePattern": "/",
              "destination": "/clientLanding",
              "preserveUnmatchedPath": true
            }
          }
        ]
      }
    ]
  }
}
```

---

## End-to-End Flow
1. Get Azure Auth token.  
2. Create domain record in Front Door.  
3. Return DNS records → show in UI.  
4. Poll until verification succeeds (Verify button continues if paused).  
5. Fetch app routes.  
6. Patch route with new domain.  
7. Create rule set for custom routing.
8. **Associate domain with endpoint and routes (merge-safe pattern)**.

---

# Step 8: Associate Custom Domain to Endpoint and Route (Merge-Safe)

## Problem
When using the Azure Front Door API to associate a custom domain with a route, a `PATCH` request **replaces** the entire `customDomains` array rather than merging it. If you send only one domain, Azure removes all other existing associations.

## Solution: Read-Before-Write Pattern

### Step 8A: Get Domain Resource ID
**Purpose**: Retrieve the actual domain resource ID that Azure expects.  
**Endpoint**:  
`GET https://management.azure.com/subscriptions/{subId}/resourceGroups/{rg}/providers/Microsoft.Cdn/profiles/{afdProfile}/customDomains?api-version=2024-02-01`

**Response**: Find the domain by `hostName` and extract the `id` field.

### Step 8B: GET Current Route Configuration
**Purpose**: Retrieve existing route to preserve all current domain associations.  
**Endpoint**:  
`GET https://management.azure.com/subscriptions/{subId}/resourceGroups/{rg}/providers/Microsoft.Cdn/profiles/{afdProfile}/afdendpoints/{endpointName}/routes/{routeName}?api-version=2024-02-01`

### Step 8C: Merge Domain Lists
**Purpose**: Combine existing domains with new domain to prevent overwriting.  
**Logic**:
```js
const existingDomains = currentRoute.properties?.customDomains?.map(d => d.id) || [];
const mergedDomains = Array.from(new Set([...existingDomains, newDomainId]));
```

### Step 8D: PATCH Route with Merged List
**Purpose**: Update route with complete domain list (existing + new).  
**Endpoint**:  
`PATCH https://management.azure.com/subscriptions/{subId}/resourceGroups/{rg}/providers/Microsoft.Cdn/profiles/{afdProfile}/afdendpoints/{endpointName}/routes/{routeName}?api-version=2024-02-01`

**Body**:
```json
{
  "properties": {
    "customDomains": [
      { "id": "/subscriptions/.../customDomains/tenant1-app" },
      { "id": "/subscriptions/.../customDomains/tenant2-app" },
      { "id": "/subscriptions/.../customDomains/new-tenant-app" }
    ]
  }
}
```

### Step 8E: Verify Association Status
**Purpose**: Confirm the domain was successfully associated by checking the route's customDomains array.  
**Logic**: Check if the domain resource ID exists in the route's `customDomains` array.

**Expected Result**: `endpointAssociation: "Associated"`

---

## Complete 8-Step Azure Front Door Domain Configuration Process

1. **Get Azure access token** - OAuth2 client credentials flow
2. **Create custom domain in Azure Front Door** - Register domain and get verification token
3. **Get AFD endpoint hostname for CNAME** - Return DNS records to tenant
4. **Poll until DNS approved** - Wait for domain validation to succeed
5. **Fetch the app routes in oe-prod** - Get current route configuration
6. **Patch the app routes to include the new domain name** - Add domain to route
7. **Create Rule Set** - Add custom routing rules for the domain
8. **Associate custom domain with endpoint and routes (merge-safe pattern)**
   - 8A: Get domain resource ID from Azure
   - 8B: GET current route to preserve existing associations
   - 8C: Merge existing domains with new domain
   - 8D: PATCH route with merged domain list
   - 8E: Verify association status

---

## Key Benefits of Merge-Safe Pattern

- **🛡️ Safe for Production**: Won't remove existing tenant domains
- **🔄 Idempotent**: Can be run multiple times safely
- **📈 Scalable**: Supports hundreds of domain associations
- **🔍 Debugging**: Logs existing and merged domain lists
- **⚡ Efficient**: Uses `Set` to prevent duplicates

---

## Backend API Endpoints

### POST /api/custom-domains/configure
**Purpose**: Create custom domain in Azure Front Door and return DNS records.  
**Body**: `{ tenantId, subdomainOption, domainName }`  
**Response**: DNS records (CNAME + TXT with ASUID token)

### POST /api/custom-domains/verify
**Purpose**: Verify DNS configuration and associate domain with route.  
**Body**: `{ tenantId, subdomainOption, domainName }`  
**Response**: 
```json
{
  "status": "verified",
  "message": "Domain verified and associated successfully",
  "provisioningState": "Succeeded",
  "deploymentStatus": "Succeeded", 
  "endpointAssociation": "Associated"
}
```

### DELETE /api/custom-domains
**Purpose**: Remove custom domain from Azure Front Door.  
**Body**: `{ tenantId, subdomainOption, domainName }`




Here's a POSTMAN JSON Export of the working API calls

{
	"info": {
		"_postman_id": "668bd0c5-cd07-4caf-a102-e7052dada87f",
		"name": "Azure Front Door",
		"schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
		"_exporter_id": "38539121",
		"_collection_link": "https://team-oe-2187.postman.co/workspace/Team-OE-Workspace~0e544c28-8373-4229-8268-259dadb75121/collection/38539121-668bd0c5-cd07-4caf-a102-e7052dada87f?action=share&source=collection_link&creator=38539121"
	},
	"item": [
		{
			"name": "Step 1 - Auth Token",
			"request": {
				"auth": {
					"type": "noauth"
				},
				"method": "POST",
				"header": [],
				"body": {
					"mode": "urlencoded",
					"urlencoded": [
						{
							"key": "client_id",
							"value": "0004ba1d-e1e3-4aa0-907e-e21c8cf7296a",
							"type": "text"
						},
						{
							"key": "client_secret",
							"value": "ird8Q~PLZfEJ16CVMg0.74.00kkKI3JYr290zcEy",
							"type": "text"
						},
						{
							"key": "grant_type",
							"value": "client_credentials",
							"type": "text"
						},
						{
							"key": "scope",
							"value": "https://management.azure.com/.default",
							"type": "text"
						}
					]
				},
				"url": {
					"raw": "https://login.microsoftonline.com/{{tenant_id}}/oauth2/v2.0/token",
					"protocol": "https",
					"host": [
						"login",
						"microsoftonline",
						"com"
					],
					"path": [
						"{{tenant_id}}",
						"oauth2",
						"v2.0",
						"token"
					]
				}
			},
			"response": []
		},
		{
			"name": "Step 2 - Create New Client Record",
			"request": {
				"auth": {
					"type": "noauth"
				},
				"method": "PUT",
				"header": [],
				"body": {
					"mode": "raw",
					"raw": "{\r\n  \"properties\": {\r\n    \"hostName\": \"{{tenant_domain}}\",\r\n    \"tlsSettings\": {\r\n      \"certificateType\": \"ManagedCertificate\",\r\n      \"minimumTlsVersion\": \"TLS12\"\r\n    }\r\n  }\r\n}",
					"options": {
						"raw": {
							"language": "json"
						}
					}
				},
				"url": {
					"raw": "https://management.azure.com/subscriptions/{{subscription_id}}/resourceGroups/{{resource_group}}/providers/Microsoft.Cdn/profiles/{{profile_name}}/customDomains/{{tenant_domain_name}}?api-version={{api_version}}",
					"protocol": "https",
					"host": [
						"management",
						"azure",
						"com"
					],
					"path": [
						"subscriptions",
						"{{subscription_id}}",
						"resourceGroups",
						"{{resource_group}}",
						"providers",
						"Microsoft.Cdn",
						"profiles",
						"{{profile_name}}",
						"customDomains",
						"{{tenant_domain_name}}"
					],
					"query": [
						{
							"key": "api-version",
							"value": "{{api_version}}"
						}
					]
				}
			},
			"response": []
		},
		{
			"name": "Step 3 - Fetch CNAME AFD",
			"request": {
				"auth": {
					"type": "noauth"
				},
				"method": "GET",
				"header": [],
				"url": {
					"raw": "https://management.azure.com/subscriptions/{{subscription_id}}/resourceGroups/{{resource_group}}/providers/Microsoft.Cdn/profiles/{{profile_name}}/afdEndpoints/{{endpoint_name}}?api-version={{api_version}}",
					"protocol": "https",
					"host": [
						"management",
						"azure",
						"com"
					],
					"path": [
						"subscriptions",
						"{{subscription_id}}",
						"resourceGroups",
						"{{resource_group}}",
						"providers",
						"Microsoft.Cdn",
						"profiles",
						"{{profile_name}}",
						"afdEndpoints",
						"{{endpoint_name}}"
					],
					"query": [
						{
							"key": "api-version",
							"value": "{{api_version}}"
						}
					]
				}
			},
			"response": []
		},
		{
			"name": "Step 4 - Poll until approved",
			"request": {
				"auth": {
					"type": "bearer",
					"bearer": [
						{
							"key": "token",
							"value": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsIng1dCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSIsImtpZCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSJ9.eyJhdWQiOiJodHRwczovL21hbmFnZW1lbnQuYXp1cmUuY29tIiwiaXNzIjoiaHR0cHM6Ly9zdHMud2luZG93cy5uZXQvOTE1ZjA0YmUtZDMyOC00OGI4LWJiNWMtOTI4YzcwMGRiY2U3LyIsImlhdCI6MTc1NzI1OTMxMiwibmJmIjoxNzU3MjU5MzEyLCJleHAiOjE3NTcyNjMyMTIsImFpbyI6IkFXUUFtLzhaQUFBQXRoK2wvZFNpVEUyWnNGb1pPOHNqTkZqcUdoRjl0NzA5TTdXMXVvSjd6cXhGK0tWZ3NWRHJsWCtheW9mcW0wWHhWSnFJNGhPL1pydGVQYVRncU1NVzlmdTdiSVloSHdOMmFML3FpMENQYkdaaWZ6aHQ4VlZDaHVYYnRMOWEvczN1IiwiYXBwaWQiOiIwMDA0YmExZC1lMWUzLTRhYTAtOTA3ZS1lMjFjOGNmNzI5NmEiLCJhcHBpZGFjciI6IjEiLCJpZHAiOiJodHRwczovL3N0cy53aW5kb3dzLm5ldC85MTVmMDRiZS1kMzI4LTQ4YjgtYmI1Yy05MjhjNzAwZGJjZTcvIiwiaWR0eXAiOiJhcHAiLCJvaWQiOiI4YmQxM2FhNi01NGVlLTRiZmQtODI1Zi1kMmZiMTg3ZDc0ZGMiLCJyaCI6IjEuQWNvQXZnUmZrU2pUdUVpN1hKS01jQTI4NTBaSWYza0F1dGRQdWtQYXdmajJNQlBMQVFES0FBLiIsInN1YiI6IjhiZDEzYWE2LTU0ZWUtNGJmZC04MjVmLWQyZmIxODdkNzRkYyIsInRpZCI6IjkxNWYwNGJlLWQzMjgtNDhiOC1iYjVjLTkyOGM3MDBkYmNlNyIsInV0aSI6IlVNQmJoUG1rZWtPUDdpQ0tSSlJvQUEiLCJ2ZXIiOiIxLjAiLCJ4bXNfZnRkIjoiSEd1LW9wZ0ktZl9UdEdrQmlzV2QyRDFETC1ab1o5WERsbXhLc2kxMWhSY0JkWE4zWlhOME15MWtjMjF6IiwieG1zX2lkcmVsIjoiMjAgNyIsInhtc19yZCI6IjAuNDJMallCSmlPc1VvSk1MQkxpU2dmbmtobV9PQmJlNDd0MjllZlo3eHJ4VlFsRk5Jb0oxOVNsZU45MGVQaFhlbjlaVnNNSXdIaW5JSUNiaDUxRmN5N0xydXY4djUxc0VmM3d5RUFRIiwieG1zX3RjZHQiOjE3NTY0MDc4OTV9.EM2Qc4Txkek_SjzGdd0azZkBU_EVP_Vijo0ayfE-rydDjW0k_tiKe98N9IrThtcuHQXlkc-HAB6jCWWpNTFiguc4hdKPeZY1s7yGDfEga8-VLT3VCJTfXLG1jiT7RIsC381Fk5QTGLxZci_Kc7tHfKxEgZdFB_WOtEoa23JFWhBpuZ5WEUrgxSAR8iL80306vZF9-WsVhr7EiAbt4keG4HcXwmX_DVKA7nKwIcfT0rq1S9hMm77hL8l93NF-wksoNipAKLpHg5pJt8MrsVD3qVDiNTLaqJ5cEtjchCbBR2q2YBb0nvAP-K7cMfvzErdPr88Y7be5TYEpQI0baPIxvQ",
							"type": "string"
						}
					]
				},
				"method": "GET",
				"header": [],
				"url": {
					"raw": "https://management.azure.com/subscriptions/8189966e-8ff7-4e7c-826f-215a8bb3355b/resourceGroups/or-FrontDoor-rg/providers/Microsoft.Cdn/profiles/or-FrontDoor/customDomains/mightywell-portal?api-version={{api_version}}",
					"protocol": "https",
					"host": [
						"management",
						"azure",
						"com"
					],
					"path": [
						"subscriptions",
						"8189966e-8ff7-4e7c-826f-215a8bb3355b",
						"resourceGroups",
						"or-FrontDoor-rg",
						"providers",
						"Microsoft.Cdn",
						"profiles",
						"or-FrontDoor",
						"customDomains",
						"mightywell-portal"
					],
					"query": [
						{
							"key": "api-version",
							"value": "{{api_version}}"
						}
					]
				}
			},
			"response": []
		},
		{
			"name": "Step 5 - Fetch the App Route in oe-prod",
			"request": {
				"auth": {
					"type": "bearer",
					"bearer": [
						{
							"key": "token",
							"value": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsIng1dCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSIsImtpZCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSJ9.eyJhdWQiOiJodHRwczovL21hbmFnZW1lbnQuYXp1cmUuY29tIiwiaXNzIjoiaHR0cHM6Ly9zdHMud2luZG93cy5uZXQvOTE1ZjA0YmUtZDMyOC00OGI4LWJiNWMtOTI4YzcwMGRiY2U3LyIsImlhdCI6MTc1NzI1OTc3MywibmJmIjoxNzU3MjU5NzczLCJleHAiOjE3NTcyNjM2NzMsImFpbyI6IkFXUUFtLzhaQUFBQWhoL1JTZU1UU1o4ZitjWEszNHdYbkxCek4wMWxGc3dFekdXVUZGV1pTeHlGK1VZUSthSVBuaGZucEN5b2Mva0RuTDYvWTR6NVdhd005bkZEWkU0Ym5GelJCRER4VWpMemgrbG1zQlI0MlU3alVUWlZzd0RYT083Q1h1VFpxMGgvIiwiYXBwaWQiOiIwMDA0YmExZC1lMWUzLTRhYTAtOTA3ZS1lMjFjOGNmNzI5NmEiLCJhcHBpZGFjciI6IjEiLCJpZHAiOiJodHRwczovL3N0cy53aW5kb3dzLm5ldC85MTVmMDRiZS1kMzI4LTQ4YjgtYmI1Yy05MjhjNzAwZGJjZTcvIiwiaWR0eXAiOiJhcHAiLCJvaWQiOiI4YmQxM2FhNi01NGVlLTRiZmQtODI1Zi1kMmZiMTg3ZDc0ZGMiLCJyaCI6IjEuQWNvQXZnUmZrU2pUdUVpN1hKS01jQTI4NTBaSWYza0F1dGRQdWtQYXdmajJNQlBMQVFES0FBLiIsInN1YiI6IjhiZDEzYWE2LTU0ZWUtNGJmZC04MjVmLWQyZmIxODdkNzRkYyIsInRpZCI6IjkxNWYwNGJlLWQzMjgtNDhiOC1iYjVjLTkyOGM3MDBkYmNlNyIsInV0aSI6IkF0MTh5QVF0VmtPd0VEOXgzd2h0QUEiLCJ2ZXIiOiIxLjAiLCJ4bXNfZnRkIjoiVUxSZWR6blFtanZXN2ZJV3ZOVlh2LXF2dUhobVYtcDRDaHgwWDRNOFBYd0JkWE5sWVhOMExXUnpiWE0iLCJ4bXNfaWRyZWwiOiIxOCA3IiwieG1zX3JkIjoiMC40MkxqWUJKaU9zVW9KTUxCTGlTZ2Zua2htX09CYmU0N3QyOWVmWjd4cnhWUWxGTklvSjE5U2xlTjkwZVBoWGVuOVpWc01Jd0hpbklJQ2JoNTFGY3k3THJ1djh2NTFzRWYzd3lFQVEiLCJ4bXNfdGNkdCI6MTc1NjQwNzg5NX0.GcmK66jDXbOKOXXpKPHBZWU3BNQXFniwNfoRUw0WzYbqWNOMwsEvu3y2OOLOjwC-pvQNb2V-0KfJ-lYqquqs7jQoXoG6nHyfd3ZS5lJh7pQdDJO8cOL9sRiFe8oaBBCI45VsOcE-oKnLqVcuwWeiEPQSNcsBd_VTHJticKR5af9Bv5Co02qv4nDCo8j3LHJQh8qw7z8sNtAcMnJvX-qHUCHNb9s_qGd8DdNSehOKbs9r_uSUS3ab52oGgNvDSmzWGdWXeqEHtIF6yrbY9dVifjhr0HQUzR8elf3uqFIOUUU72IaSrZyQYgrSR2sf3VcULxXADAY1juMe1i8j1G47OA",
							"type": "string"
						}
					]
				},
				"method": "GET",
				"header": [],
				"url": {
					"raw": "https://management.azure.com/subscriptions/8189966e-8ff7-4e7c-826f-215a8bb3355b/resourceGroups/or-FrontDoor-rg/providers/Microsoft.Cdn/profiles/or-FrontDoor/afdEndpoints/oe-prod/routes?api-version={{api_version}}",
					"protocol": "https",
					"host": [
						"management",
						"azure",
						"com"
					],
					"path": [
						"subscriptions",
						"8189966e-8ff7-4e7c-826f-215a8bb3355b",
						"resourceGroups",
						"or-FrontDoor-rg",
						"providers",
						"Microsoft.Cdn",
						"profiles",
						"or-FrontDoor",
						"afdEndpoints",
						"oe-prod",
						"routes"
					],
					"query": [
						{
							"key": "api-version",
							"value": "{{api_version}}"
						}
					]
				}
			},
			"response": []
		},
		{
			"name": "Step 6 - Patch the app routes to include the new domain",
			"request": {
				"auth": {
					"type": "bearer",
					"bearer": [
						{
							"key": "token",
							"value": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsIng1dCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSIsImtpZCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSJ9.eyJhdWQiOiJodHRwczovL21hbmFnZW1lbnQuYXp1cmUuY29tIiwiaXNzIjoiaHR0cHM6Ly9zdHMud2luZG93cy5uZXQvOTE1ZjA0YmUtZDMyOC00OGI4LWJiNWMtOTI4YzcwMGRiY2U3LyIsImlhdCI6MTc1NzI1OTk4OSwibmJmIjoxNzU3MjU5OTg5LCJleHAiOjE3NTcyNjM4ODksImFpbyI6IkFXUUFtLzhaQUFBQStiRjRoVlZPNEsxVUt6UWtvY2lUMERneHV6U0tjS1ZRMjdITkVVbDh0SXJmaDNOdkhMV3h1UlNlV2NFN3JBejRJdzc2aGF4VTFHUmVEa3NNbGFKYXFzdTFLLy8rTDgrbFhVc2RZZjIrMlcrOUVsaWYxbWxxdkhQUCs2ZGRCNnBCIiwiYXBwaWQiOiIwMDA0YmExZC1lMWUzLTRhYTAtOTA3ZS1lMjFjOGNmNzI5NmEiLCJhcHBpZGFjciI6IjEiLCJpZHAiOiJodHRwczovL3N0cy53aW5kb3dzLm5ldC85MTVmMDRiZS1kMzI4LTQ4YjgtYmI1Yy05MjhjNzAwZGJjZTcvIiwiaWR0eXAiOiJhcHAiLCJvaWQiOiI4YmQxM2FhNi01NGVlLTRiZmQtODI1Zi1kMmZiMTg3ZDc0ZGMiLCJyaCI6IjEuQWNvQXZnUmZrU2pUdUVpN1hKS01jQTI4NTBaSWYza0F1dGRQdWtQYXdmajJNQlBMQVFES0FBLiIsInN1YiI6IjhiZDEzYWE2LTU0ZWUtNGJmZC04MjVmLWQyZmIxODdkNzRkYyIsInRpZCI6IjkxNWYwNGJlLWQzMjgtNDhiOC1iYjVjLTkyOGM3MDBkYmNlNyIsInV0aSI6Ik5xakZTek9EZDBDZE0ybHJkYVpBQUEiLCJ2ZXIiOiIxLjAiLCJ4bXNfZnRkIjoienc3SjlzWVRaeHdZc0NCNzBwWUd4dzBCaHhsQmdXdUFTZ0hIRU1YcVUzb0JkWE56YjNWMGFDMWtjMjF6IiwieG1zX2lkcmVsIjoiNyAyMCIsInhtc19yZCI6IjAuNDJMallCSmlPc1VvSk1MQkxpU2dmbmtobV9PQmJlNDd0MjllZlo3eHJ4VlFsRk5Jb0oxOVNsZU45MGVQaFhlbjlaVnNNSXdIaW5JSUNiaDUxRmN5N0xydXY4djUxc0VmM3d5RUFRIiwieG1zX3RjZHQiOjE3NTY0MDc4OTV9.oAjiU6NaDN-s7pU-cn-NkXRyGV8gSiHtwWBpIHFPRwzNtba-dhRtBn8bpxuFJ3ZMDJeb0wHRxDesDxrWimwvtqtuwJIXOs8Wm7_wDhB9sg8TrFflmJuPevcdOOr6GxZnkW_1yfFJpwZBNxqbQ_zKYnxy0F8bjgAKZpKOMvVbw2q9vpIF66Prx47YOQtLpMCSeThb4GlH_HA2kg0BZwsnO_2PhxDx0Ffs5xFQDkJ1W__mCjv2en1qSK54S49Hp4Xq6RUNAEL26k7_5nIwHm61w-xO279QfCL1pxifJl7oEcu1SQV_YvUElvWV-80pbS4HO_S4Ozc7Lv7LE_hZLPsjTA",
							"type": "string"
						}
					]
				},
				"method": "PATCH",
				"header": [
					{
						"key": "Content-Type",
						"value": "application/json",
						"type": "text"
					}
				],
				"body": {
					"mode": "raw",
					"raw": "{\r\n  \"properties\": {\r\n    \"customDomains\": [\r\n      {\r\n        \"id\": \"/subscriptions/8189966e-8ff7-4e7c-826f-215a8bb3355b/resourcegroups/or-FrontDoor-rg/providers/Microsoft.Cdn/profiles/or-FrontDoor/customdomains/app-open-enroll-com-a3b7\"\r\n      },\r\n      {\r\n        \"id\": \"/subscriptions/8189966e-8ff7-4e7c-826f-215a8bb3355b/resourcegroups/or-FrontDoor-rg/providers/Microsoft.Cdn/profiles/or-FrontDoor/customdomains/mightywell-portal\"\r\n      }\r\n    ],\r\n    \"originGroup\": {\r\n      \"id\": \"/subscriptions/8189966e-8ff7-4e7c-826f-215a8bb3355b/resourcegroups/or-FrontDoor-rg/providers/Microsoft.Cdn/profiles/or-FrontDoor/origingroups/og-app\"\r\n    },\r\n    \"originPath\": null,\r\n    \"ruleSets\": [],\r\n    \"supportedProtocols\": [\"Http\",\"Https\"],\r\n    \"patternsToMatch\": [\"/*\"],\r\n    \"forwardingProtocol\": \"MatchRequest\",\r\n    \"linkToDefaultDomain\": \"Enabled\",\r\n    \"httpsRedirect\": \"Enabled\",\r\n    \"enabledState\": \"Enabled\"\r\n  }\r\n}\r\n",
					"options": {
						"raw": {
							"language": "json"
						}
					}
				},
				"url": {
					"raw": "https://management.azure.com/subscriptions/8189966e-8ff7-4e7c-826f-215a8bb3355b/resourceGroups/or-FrontDoor-rg/providers/Microsoft.Cdn/profiles/or-FrontDoor/afdEndpoints/oe-prod/routes/app-prod?api-version={{api_version}}",
					"protocol": "https",
					"host": [
						"management",
						"azure",
						"com"
					],
					"path": [
						"subscriptions",
						"8189966e-8ff7-4e7c-826f-215a8bb3355b",
						"resourceGroups",
						"or-FrontDoor-rg",
						"providers",
						"Microsoft.Cdn",
						"profiles",
						"or-FrontDoor",
						"afdEndpoints",
						"oe-prod",
						"routes",
						"app-prod"
					],
					"query": [
						{
							"key": "api-version",
							"value": "{{api_version}}"
						}
					]
				}
			},
			"response": []
		},
		{
			"name": "Step 7 - Create Rule Set",
			"request": {
				"auth": {
					"type": "bearer",
					"bearer": [
						{
							"key": "token",
							"value": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsIng1dCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSIsImtpZCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSJ9.eyJhdWQiOiJodHRwczovL21hbmFnZW1lbnQuYXp1cmUuY29tIiwiaXNzIjoiaHR0cHM6Ly9zdHMud2luZG93cy5uZXQvOTE1ZjA0YmUtZDMyOC00OGI4LWJiNWMtOTI4YzcwMGRiY2U3LyIsImlhdCI6MTc1NzI4MDMwMiwibmJmIjoxNzU3MjgwMzAyLCJleHAiOjE3NTcyODQyMDIsImFpbyI6IkFXUUFtLzhaQUFBQWROMWRITkdNT2lVaXYyMUxaalVXeDViQ0RRSWk5T3puRVUwTXYxd05zNlpndDA5Mnkvc1JhanJ4K2NNY3FYNjAzenJTbGRLekRvRW15a0dJYnNCK2c1WFJxSHA4cXczVFkzcnBRcGlTaDdRYUlxS0xNYm8wdjgvTC9jWm9lUFk3IiwiYXBwaWQiOiIwMDA0YmExZC1lMWUzLTRhYTAtOTA3ZS1lMjFjOGNmNzI5NmEiLCJhcHBpZGFjciI6IjEiLCJpZHAiOiJodHRwczovL3N0cy53aW5kb3dzLm5ldC85MTVmMDRiZS1kMzI4LTQ4YjgtYmI1Yy05MjhjNzAwZGJjZTcvIiwiaWR0eXAiOiJhcHAiLCJvaWQiOiI4YmQxM2FhNi01NGVlLTRiZmQtODI1Zi1kMmZiMTg3ZDc0ZGMiLCJyaCI6IjEuQWNvQXZnUmZrU2pUdUVpN1hKS01jQTI4NTBaSWYza0F1dGRQdWtQYXdmajJNQlBMQVFES0FBLiIsInN1YiI6IjhiZDEzYWE2LTU0ZWUtNGJmZC04MjVmLWQyZmIxODdkNzRkYyIsInRpZCI6IjkxNWYwNGJlLWQzMjgtNDhiOC1iYjVjLTkyOGM3MDBkYmNlNyIsInV0aSI6IlluYjlld04xU2t5Zm1Nb0RPbmVVQUEiLCJ2ZXIiOiIxLjAiLCJ4bXNfZnRkIjoiTGN4S19jWllVMVA2WXlYa2xEeXN5aHFxTEVpRExma1hjVTdfa2tkR3dGMEJkWE56YjNWMGFDMWtjMjF6IiwieG1zX2lkcmVsIjoiNyAzMCIsInhtc19yZCI6IjAuNDJMallCSmlPc1VvSk1MQkxpU2dmbmtobV9PQmJlNDd0MjllZlo3eHJ4VlFsRk5Jb0oxOVNsZU45MGVQaFhlbjlaVnNNSXdIaW5JSUNiaDUxRmN5N0xydXY4djUxc0VmM3d5RUFRIiwieG1zX3RjZHQiOjE3NTY0MDc4OTV9.HKZ5VYhpxVIB5VjTwyeQUs8kWUDUyXW7GInQGVpfua9Lh5C-JAgK5mVGVaeOsOtT-8Si-LMouqow0ke9Cdc8EbYKfL1EU2aP3IAUn_cqWeLtCTePH11Yw-UrCYQXMBXt-LofKjkk0iYggzrJ5FqTS8p6uFpXIz2mE1AzDL-Md1eU_rjKfOdv_v0qXMwOwVnCtWNg_iOHxypYRAIWob0dqYeDU-usIxCHOW1e3vrB4iAn5qwIYHnREN8aWnRS3OOZj_0wSomVUY60jaQ_2FQfPnszYZlD8mc-Pwgme7TYMy37aCV-fV5JzxSISTAp-95GgOogdigBmBNNf_zKnzW7Vg",
							"type": "string"
						}
					]
				},
				"method": "PUT",
				"header": [],
				"url": {
					"raw": "https://management.azure.com/subscriptions/{{subscription_id}}/resourceGroups/{{resource_group}}/providers/Microsoft.Cdn/profiles/{{profile_name}}/ruleSets/{{ruleset_name}}?api-version={{api_version}}",
					"protocol": "https",
					"host": [
						"management",
						"azure",
						"com"
					],
					"path": [
						"subscriptions",
						"{{subscription_id}}",
						"resourceGroups",
						"{{resource_group}}",
						"providers",
						"Microsoft.Cdn",
						"profiles",
						"{{profile_name}}",
						"ruleSets",
						"{{ruleset_name}}"
					],
					"query": [
						{
							"key": "api-version",
							"value": "{{api_version}}"
						}
					]
				}
			},
			"response": []
		}
	]
}


Variables for AZURE
tenant_id = 915f04be-d328-48b8-bb5c-928c700dbce7
client_id = 0004ba1d-e1e3-4aa0-907e-e21c8cf7296a
client_secret = ird8Q~PLZfEJ16CVMg0.74.00kkKI3JYr290zcEy
client_type = client_credentials
scope = https://management.azure.com/.default
subscription_id = 8189966e-8ff7-4e7c-826f-215a8bb3355b
resource_group = or-FrontDoor-rg
profile_name = or-FrontDoor
tenant_domain_name = the tenants domain with custom domain (from the dropdown - e.g. mightywell-portal)
api_version = 2025-04-15
endpoint_name = oe-prod
ruleset_name = client domain name (e.g. mightywellhealth)
