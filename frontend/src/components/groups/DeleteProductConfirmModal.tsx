// frontend/src/components/groups/DeleteProductConfirmModal.tsx
import React from 'react';
import { Trash2 } from 'lucide-react';

interface DeleteProductConfirmModalProps {
  productName: string;
  /** null when still loading the count */
  enrollmentCount: number | null;
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const DeleteProductConfirmModal: React.FC<DeleteProductConfirmModalProps> = ({
  productName,
  enrollmentCount,
  isLoading = false,
  onConfirm,
  onCancel,
}) => {
  const hasEnrollments = !isLoading && (enrollmentCount ?? 0) > 0;
  const memberWord = enrollmentCount === 1 ? 'member is' : 'members are';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 shadow-xl">
        <div className="p-6">
          <div className="flex items-start gap-3">
            <Trash2 className="h-5 w-5 text-red-600 mt-0.5" aria-hidden />
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900">
                Remove <span className="font-bold">{productName}</span> from this group?
              </h3>

              {isLoading ? (
                <p className="mt-3 text-sm text-gray-600">Checking enrollments…</p>
              ) : hasEnrollments ? (
                <>
                  <p className="mt-3 text-sm text-gray-700 font-medium">
                    {enrollmentCount} {memberWord} currently enrolled — their enrollments will continue unchanged.
                  </p>
                  <p className="mt-2 text-sm text-gray-600">
                    The product will not appear in new enrollment links. You can add it back anytime from the Removed Products section below.
                  </p>
                </>
              ) : (
                <p className="mt-3 text-sm text-gray-600">
                  It will no longer appear in enrollment links. You can add it back anytime using the Add Product button at the top of the page.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 pb-6">
          <button
            type="button"
            onClick={onCancel}
            className="border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md px-4 py-2 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className="bg-red-600 hover:bg-red-700 text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteProductConfirmModal;
