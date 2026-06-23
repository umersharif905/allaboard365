import { apiService } from '../services/api.service';
import type {
  CardSection,
  IDCardSection,
  IDCardVariation,
  ProductFormData
} from '../types/sysadmin/addproductswizard.types';

type UploadResponse = {
  success?: boolean;
  url?: string;
  data?: Array<{ url: string }> | { url?: string };
  message?: string;
};

const EMPTY_CARD_SECTION: CardSection = {
  Image: '',
  Header: '',
  Text1: '',
  Link_Name1: '',
  URL1: '',
  Link_Name2: '',
  URL2: ''
};

const EMPTY_ID_CARD_SECTION: IDCardSection = {
  Image: ''
};

const EMPTY_CARD_BACK: IDCardVariation['Card_Back'] = {
  Top_Left: EMPTY_ID_CARD_SECTION,
  Top_Right: EMPTY_ID_CARD_SECTION,
  Middle: EMPTY_ID_CARD_SECTION,
  Bottom_Left: EMPTY_ID_CARD_SECTION,
  Bottom_Right: EMPTY_ID_CARD_SECTION
};

const EMPTY_CARD_FRONT: IDCardVariation['Card_Front'] = {
  Header: { Image: '' },
  Footer: { Header: '', Text1: '', Text2: '' }
};

async function uploadWizardFile(file: File, uploadType: string, entityId: string): Promise<string | undefined> {
  const formData = new FormData();
  formData.append('files', file);
  formData.append('uploadType', uploadType);
  formData.append('entityId', entityId);
  formData.append('fileType', uploadType);

  const result = await apiService.post<UploadResponse>('/api/uploads', formData);
  if (!result.success) {
    throw new Error(result.message || 'Upload failed');
  }
  return result.url
    || (Array.isArray(result.data) && result.data.length > 0 ? result.data[0]?.url : undefined)
    || (result.data && !Array.isArray(result.data) ? result.data.url : undefined);
}

const ID_CARD_BACK_SECTIONS = ['Top_Left', 'Top_Right', 'Middle', 'Bottom_Left', 'Bottom_Right'] as const;

export async function uploadProductWizardAssets(
  productData: ProductFormData,
  options: { entityId?: string } = {}
): Promise<{
  productImageUrl?: string;
  productLogoUrl?: string;
  productDocumentUrl?: string;
  productDocuments?: ProductFormData['productDocuments'];
  idCardData?: ProductFormData['idCardData'];
  planDetailsData?: ProductFormData['planDetailsData'];
  uploadFailures: string[];
}> {
  const entityId = options.entityId || 'product-wizard';
  const uploadFailures: string[] = [];
  let productImageUrl: string | undefined;
  let productLogoUrl: string | undefined;
  let productDocumentUrl: string | undefined;
  let idCardData = productData.idCardData;
  let planDetailsData = productData.planDetailsData;

  const tryUpload = async (file: File, uploadType: string, label: string) => {
    try {
      return await uploadWizardFile(file, uploadType, entityId);
    } catch (error) {
      console.error(`Product wizard upload failed (${label}):`, error);
      uploadFailures.push(`${label} (${file.name})`);
      return undefined;
    }
  };

  if (productData.productImageFile) {
    const url = await tryUpload(productData.productImageFile, 'logos', 'Product image');
    if (url) {
      productImageUrl = url;
      productLogoUrl = url;
    }
  }

  if (productData.productLogoFile) {
    const url = await tryUpload(productData.productLogoFile, 'logos', 'Product logo');
    if (url) productLogoUrl = url;
  }

  if (productData.productDocumentFile) {
    const url = await tryUpload(productData.productDocumentFile, 'documents', 'Plan document');
    if (url) productDocumentUrl = url;
  }

  const uploadedNewDocuments: NonNullable<ProductFormData['productDocuments']> = [];
  for (const item of productData.productDocumentFiles || []) {
    if (!item?.file || !(item.file instanceof File)) continue;
    const url = await tryUpload(item.file, 'documents', 'Plan document');
    if (url) {
      uploadedNewDocuments.push({
        documentUrl: url,
        displayName: item.displayName?.trim() || item.file.name || 'Document',
        sortOrder: uploadedNewDocuments.length
      });
    }
  }

  const existingDocs = (productData.productDocuments || []).filter((doc) => doc?.documentUrl);
  const withLegacy = productDocumentUrl
    ? [...existingDocs, {
      documentUrl: productDocumentUrl,
      displayName: (productData as ProductFormData & { productDocumentName?: string }).productDocumentName || 'Document',
      sortOrder: existingDocs.length
    }]
    : existingDocs;
  const productDocuments = [...withLegacy, ...uploadedNewDocuments].map((doc, index) => ({
    ...doc,
    sortOrder: index
  }));

  if (productData.idCardLogoFile) {
    const url = await tryUpload(productData.idCardLogoFile, 'logos', 'ID card logo');
    if (url && idCardData) {
      idCardData = {
        ...idCardData,
        Card_Front: {
          ...idCardData.Card_Front,
          Header: {
            ...idCardData.Card_Front?.Header,
            Image: url
          }
        }
      };
    }
  }

  if (productData.idCardBackImageFiles) {
    for (const section of ID_CARD_BACK_SECTIONS) {
      const file = productData.idCardBackImageFiles[section];
      if (!file) continue;
      const url = await tryUpload(file, 'logos', `ID card back ${section}`);
      if (!url || !idCardData) continue;
      const back = { ...idCardData.Card_Back };
      const existing = back[section] ?? EMPTY_CARD_SECTION;
      back[section] = { ...existing, Image: url };
      idCardData = { ...idCardData, Card_Back: back };
    }
  }

  if (productData.planDetailsHeaderLogoFile) {
    const url = await tryUpload(productData.planDetailsHeaderLogoFile, 'logos', 'Plan details logo');
    if (url && planDetailsData?.Plan_Data?.Header) {
      planDetailsData = {
        ...planDetailsData,
        Plan_Data: {
          ...planDetailsData.Plan_Data,
          Header: {
            ...planDetailsData.Plan_Data.Header,
            Image: url
          }
        }
      };
    }
  }

  const networkLogoFiles = productData.idCardLogoFileByNetwork;
  const networkBackFiles = productData.idCardBackImageFilesByNetwork;
  const variationKeys = new Set<string>([
    ...Object.keys(networkLogoFiles || {}),
    ...Object.keys(networkBackFiles || {}),
    ...Object.keys((idCardData?.NetworkVariations as Record<string, unknown>) || {})
  ]);

  if (variationKeys.size > 0 && idCardData) {
    const nextIdCardData = { ...idCardData };
    if (!nextIdCardData.NetworkVariations) {
      nextIdCardData.NetworkVariations = {};
    }
    for (const networkId of variationKeys) {
      if (!nextIdCardData.NetworkVariations[networkId]) {
        nextIdCardData.NetworkVariations[networkId] = JSON.parse(JSON.stringify({
          DisableIDCard: nextIdCardData.DisableIDCard === true,
          Card_Front: nextIdCardData.Card_Front,
          Card_Back: nextIdCardData.Card_Back
        })) as IDCardVariation;
      }
      const variation = nextIdCardData.NetworkVariations[networkId];
      const logoFile = networkLogoFiles?.[networkId];
      if (logoFile instanceof File) {
        const url = await tryUpload(logoFile, 'logos', `ID card logo (${networkId})`);
        if (url) {
          variation.Card_Front = variation.Card_Front ?? EMPTY_CARD_FRONT;
          variation.Card_Front.Header = { ...variation.Card_Front.Header, Image: url };
        }
      }
      const backFiles = networkBackFiles?.[networkId];
      if (backFiles) {
        for (const section of ID_CARD_BACK_SECTIONS) {
          const file = backFiles[section];
          if (!(file instanceof File)) continue;
          const url = await tryUpload(file, 'logos', `ID card back ${section} (${networkId})`);
          if (!url) continue;
          variation.Card_Back = variation.Card_Back ?? EMPTY_CARD_BACK;
          const existing = variation.Card_Back[section] ?? EMPTY_ID_CARD_SECTION;
          variation.Card_Back[section] = { ...existing, Image: url };
        }
      }
    }
    idCardData = nextIdCardData;
  }

  return {
    ...(productImageUrl ? { productImageUrl } : {}),
    ...(productLogoUrl ? { productLogoUrl } : {}),
    ...(productDocumentUrl ? { productDocumentUrl } : {}),
    ...(productDocuments.length > 0 ? { productDocuments } : {}),
    ...(idCardData ? { idCardData } : {}),
    ...(planDetailsData ? { planDetailsData } : {}),
    uploadFailures
  };
}
