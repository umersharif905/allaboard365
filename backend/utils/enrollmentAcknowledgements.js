/**
 * Returns true when the enrollment submit payload includes a digital signature
 * and at least one acknowledgement response (product + question + answer).
 * Used to gate the compliance PDF path in complete-enrollment — an empty
 * `acknowledgements: []` array is truthy in JS but must not skip the PDF block
 * when products require signed acknowledgements.
 */
function hasSignedAcknowledgementsPayload(acknowledgements, digitalSignature) {
  const sig = typeof digitalSignature === 'string' ? digitalSignature.trim() : '';
  if (!sig) return false;
  if (!Array.isArray(acknowledgements) || acknowledgements.length === 0) return false;
  return acknowledgements.some(
    (ack) =>
      Array.isArray(ack?.responses) &&
      ack.responses.some(
        (r) => r && r.questionId != null && r.productId != null && r.response != null && String(r.response).trim() !== ''
      )
  );
}

module.exports = {
  hasSignedAcknowledgementsPayload
};
